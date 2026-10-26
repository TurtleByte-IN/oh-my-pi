import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	type PendingExtensionRequest,
	type RpcExtensionUIResponse,
	requestRpcAskDialog,
	requestRpcDialog,
	requestRpcSelect,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

function requireRequest(frame: object | undefined): { id: string } {
	if (!frame || !("id" in frame)) {
		throw new Error("Expected the RPC dialog request to carry an id");
	}
	const id = frame.id;
	if (typeof id !== "string") throw new Error("Expected the RPC dialog request id to be a string");
	return { id };
}

function respond(pendingRequests: Map<string, PendingExtensionRequest>, id: string, payload: object): void {
	const request = pendingRequests.get(id);
	if (!request) throw new Error(`Expected pending RPC dialog request ${id}`);
	request.resolve({ type: "extension_ui_response", id, ...payload } as RpcExtensionUIResponse);
}

const dbQuestion: ExtensionAskDialogQuestion = {
	id: "db",
	question: "Which database?",
	options: [{ label: "Postgres" }, { label: "SQLite", description: "Embedded" }],
	recommended: 1,
};
const featuresQuestion: ExtensionAskDialogQuestion = {
	id: "features",
	question: "Which features?",
	options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
	multi: true,
};

/**
 * Scripted model: a user message ending in ask arguments as JSON becomes an ask call (omp may prepend
 * context to the first user message); a tool result ends the turn.
 */
const scriptedAskProvider = `
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";

export default function (pi) {
	pi.registerProvider("scripted", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "scripted-key",
		api: "scripted-ask",
		models: [{
			id: "ask",
			name: "Scripted ask",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 1024,
		}],
		streamSimple: (model, context) => {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.findLast(entry => entry.role === "user" || entry.role === "toolResult");
			const text = last?.role === "user" ? last.content.map(part => part.text ?? "").join("") : "";
			const argsAt = text.indexOf('{"questions"');
			const message = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				timestamp: Date.now(),
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			};
			stream.push({ type: "start", partial: message });
			if (argsAt >= 0) {
				const toolCall = { type: "toolCall", id: "ask-" + context.messages.length, name: "ask", arguments: JSON.parse(text.slice(argsAt)) };
				message.content = [toolCall];
				message.stopReason = "toolUse";
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
			}
			stream.push({ type: "done", reason: message.stopReason, message });
			return stream;
		},
	});
}
`;

describe("RPC extension UI", () => {
	it("keeps extension dialogs headless while tool selections round-trip", async () => {
		await using temp = await TempDir.create("@rpc-headless-tool-ui-");
		const fixturePath = temp.join("runtime.ts");
		const sourceDir = path.resolve(import.meta.dir, "../src");
		await Bun.write(
			fixturePath,
			`
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
globalThis.fetch = async () => { throw new Error("Offline UI fixture refuses network"); };
let extensionState;
const { session } = await createAgentSession({
  cwd: process.cwd(),
  toolNames: [],
  enableMCP: false,
  enableLsp: false,
  disableExtensionDiscovery: true,
  settings: Settings.isolated({ "compaction.enabled": false }),
  extensions: [pi => {
    pi.on("session_start", async (_event, ctx) => {
      const confirmed = await ctx.ui.confirm("Extension confirm", "Must not reach the host");
      ctx.ui.notify("Extension notification");
      extensionState = { hasUI: ctx.hasUI, confirmed };
    });
  }],
});
await runRpcMode(session, {
  headless: true,
  setToolUIContext(ui, hasUI) {
    void ui.select("Tool choice", ["Keep", "Deploy"]).then(selected => {
      ui.notify(JSON.stringify({ toolHasUI: hasUI, selected, extension: extensionState }));
    });
  },
});
`,
		);
		const child = Bun.spawn([process.execPath, fixturePath], {
			cwd: temp.path(),
			env: {
				PATH: Bun.env.PATH,
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				CI: "true",
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		});
		const stderr = new Response(child.stderr).text();
		const requests: Record<string, unknown>[] = [];
		let result: unknown;
		try {
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (!isRecord(frame) || frame.type !== "extension_ui_request") continue;
				requests.push(frame);
				if (frame.method === "select") {
					child.stdin.write(
						`${JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Deploy" })}\n`,
					);
					await child.stdin.flush();
				} else if (frame.method === "notify") {
					if (typeof frame.message === "string") result = JSON.parse(frame.message);
					break;
				} else {
					throw new Error(`Unexpected extension UI: ${JSON.stringify(frame)}`);
				}
			}
		} finally {
			child.stdin.end();
			await child.exited;
		}
		expect(result, await stderr).toEqual({
			toolHasUI: true,
			selected: "Deploy",
			extension: { hasUI: false, confirmed: false },
		});
		expect(requests.map(frame => frame.method)).toEqual(["select", "notify"]);
		expect(requests[0]).toMatchObject({ title: "Tool choice", options: ["Keep", "Deploy"] });
	}, 30_000);

	it("keeps the label-only wire shape for bare options", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcSelect(pendingRequests, output, "Action", ["Keep", "Deploy"]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: request.id,
			method: "select",
			title: "Action",
			options: ["Keep", "Deploy"],
			timeout: undefined,
		});

		respond(pendingRequests, request.id, { value: "Keep" });
		expect(await result).toBe("Keep");
	});

	it("emits aligned descriptions and resolves with the selected label", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcSelect(pendingRequests, output, "Action", [
			"Keep",
			{ label: "Deploy", description: " Push to production " },
			{ label: "Preview", description: "   " },
		]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: request.id,
			method: "select",
			title: "Action",
			options: ["Keep", "Deploy", "Preview"],
			optionDetails: [{}, { description: "Push to production" }, {}],
			timeout: undefined,
		});

		respond(pendingRequests, request.id, { value: "Deploy" });
		expect(await result).toBe("Deploy");
	});

	it("cancels the remote dialog when its signal aborts", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const controller = new AbortController();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			{ signal: controller.signal },
			false,
			{ method: "confirm", title: "High-risk command", message: "Allow this command?" },
			response => ("confirmed" in response ? response.confirmed : false),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected the RPC dialog request to carry an id");
		}

		controller.abort();

		expect(await result).toBe(false);
		expect(output).toHaveBeenNthCalledWith(1, {
			type: "extension_ui_request",
			id: request.id,
			method: "confirm",
			title: "High-risk command",
			message: "Allow this command?",
		});
		expect(output).toHaveBeenNthCalledWith(2, {
			type: "extension_ui_request",
			id: expect.any(String),
			method: "cancel",
			targetId: request.id,
		});
		expect(pendingRequests.size).toBe(0);
	});

	it("rejects secret login input, completes ordinary OAuth input, and logs the stored account out", async () => {
		await using temp = await TempDir.create("@rpc-login-");
		const extensionPath = temp.join("login.mjs");
		await Bun.write(
			extensionPath,
			`
export default function(pi) {
  globalThis.fetch = async () => { throw new Error("Offline login fixture refuses network"); };
  // rpc-alias is a second login for rpc-ordinary's credentials, like openai-codex-device.
  for (const [id, secret, storeCredentialsAs] of [["rpc-secret", true], ["rpc-ordinary", false], ["rpc-alias", false, "rpc-ordinary"]]) {
    pi.registerProvider(id, {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      models: [{
        id: "fixture",
        name: "Offline fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 512,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }],
      oauth: {
        name: id,
        storeCredentialsAs,
        login: async callbacks => {
          callbacks.onAuth({ url: "https://example.invalid/authorize" });
          return callbacks.onPrompt({ message: id, ...(secret ? { secret: true } : {}) });
        }
      }
    });
  }
}
`,
		);
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "..", "src", "cli.ts"),
				"--trusted-extension",
				extensionPath,
				"--mode",
				"rpc",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
			],
			{
				cwd: temp.path(),
				env: {
					PATH: Bun.env.PATH,
					HOME: temp.join("home"),
					PI_CODING_AGENT_DIR: temp.join("agent"),
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					XDG_CACHE_HOME: temp.join("cache"),
					CI: "true",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 20_000,
			},
		);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC login fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const inputTitles: string[] = [];
		let secretResponse: unknown;
		let ordinaryResponse: unknown;
		let loggedInProvidersResponse: unknown;
		let noProviderResponse: unknown;
		let accountsResponse: unknown;
		let logoutResponse: unknown;
		let staleLogoutResponse: unknown;
		let providersResponse: unknown;
		let loggedOutCredentialId: unknown;
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};

		try {
			await send({ type: "login", providerId: "rpc-secret", id: "secret" });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "extension_ui_request" && frame.method === "input") {
					if (typeof frame.id !== "string" || typeof frame.title !== "string") {
						throw new Error("RPC input request did not carry string id and title");
					}
					inputTitles.push(frame.title);
					await send({ type: "extension_ui_response", id: frame.id, value: crypto.randomUUID() });
				} else if (frame.type === "response" && frame.id === "secret") {
					secretResponse = frame;
					await send({ type: "login", providerId: "rpc-ordinary", id: "ordinary" });
				} else if (frame.type === "response" && frame.id === "ordinary") {
					ordinaryResponse = frame;
					await send({ type: "get_login_providers", id: "loggedIn" });
				} else if (frame.type === "response" && frame.id === "loggedIn") {
					loggedInProvidersResponse = frame;
					await send({ type: "get_logout_accounts", providerId: "rpc-alias", id: "accounts" });
				} else if (frame.type === "response" && frame.id === "accounts") {
					accountsResponse = frame;
					const accounts = isRecord(frame.data) && Array.isArray(frame.data.accounts) ? frame.data.accounts : [];
					loggedOutCredentialId = isRecord(accounts[0]) ? accounts[0].credentialId : undefined;
					await send({
						type: "logout",
						providerId: "rpc-alias",
						credentialId: loggedOutCredentialId,
						id: "logout",
					});
				} else if (frame.type === "response" && frame.id === "logout") {
					logoutResponse = frame;
					await send({
						type: "logout",
						providerId: "rpc-ordinary",
						credentialId: loggedOutCredentialId,
						id: "stale",
					});
				} else if (frame.type === "response" && frame.id === "stale") {
					staleLogoutResponse = frame;
					// Without a provider the credential store would list every provider's accounts.
					await send({ type: "get_logout_accounts", id: "noProvider" });
				} else if (frame.type === "response" && frame.id === "noProvider") {
					noProviderResponse = frame;
					await send({ type: "get_login_providers", id: "providers" });
				} else if (frame.type === "response" && frame.id === "providers") {
					providersResponse = frame;
					break;
				}
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		if (!providersResponse) throw new Error(`RPC login fixture did not finish: ${await stderr}`);
		await stderr;
		expect(secretResponse).toMatchObject({
			type: "response",
			command: "login",
			success: false,
			error: expect.stringContaining("requires secret input"),
		});
		expect(inputTitles).toEqual(["rpc-ordinary"]);
		expect(ordinaryResponse).toMatchObject({ type: "response", command: "login", success: true });
		expect(loggedInProvidersResponse).toMatchObject({
			data: {
				providers: expect.arrayContaining([
					expect.objectContaining({ id: "rpc-ordinary", authenticated: true }),
					// The alias stores under rpc-ordinary, so it is authenticated by the same credential.
					expect.objectContaining({ id: "rpc-alias", authenticated: true }),
				]),
			},
		});
		expect(accountsResponse).toMatchObject({
			success: true,
			data: { accounts: [expect.objectContaining({ provider: "rpc-ordinary", active: true })] },
		});
		expect(logoutResponse).toEqual({ id: "logout", type: "response", command: "logout", success: true, data: {} });
		expect(staleLogoutResponse).toMatchObject({
			command: "logout",
			success: false,
			error: expect.stringContaining("is not stored for rpc-ordinary"),
		});
		expect(noProviderResponse).toMatchObject({ command: "get_logout_accounts", success: false });
		expect(providersResponse).toMatchObject({
			success: true,
			data: {
				providers: expect.arrayContaining([
					expect.objectContaining({ id: "rpc-secret", authenticated: false }),
					expect.objectContaining({ id: "rpc-ordinary", authenticated: false }),
					expect.objectContaining({ id: "rpc-alias", authenticated: false }),
				]),
			},
		});
	}, 30_000);

	it("forwards masked and pre-URL prompts, takes `input` in the command, and signs API-key providers in and out", async () => {
		await using temp = await TempDir.create("@rpc-login-key-");
		const extensionPath = temp.join("login.mjs");
		await Bun.write(
			extensionPath,
			`
export default function(pi) {
  globalThis.fetch = async () => { throw new Error("Offline login fixture refuses network"); };
  const model = { id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  pi.registerProvider("rpc-preurl", {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [model],
    oauth: {
      name: "rpc-preurl",
      login: async callbacks => {
        const endpoint = await callbacks.onPrompt({ message: "Endpoint?" });
        callbacks.onAuth({ url: "https://example.invalid/keys" });
        const key = await callbacks.onPrompt({ message: "Key?", secret: true });
        return endpoint + ":" + key;
      }
    }
  });
  pi.registerProvider("rpc-keyflow", {
    baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [model],
    oauth: { name: "rpc-keyflow", login: async callbacks => callbacks.onPrompt({ message: "Key?", secret: true }) }
  });
}
`,
		);
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "..", "src", "cli.ts"),
				"--trusted-extension",
				extensionPath,
				"--mode",
				"rpc",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
			],
			{
				cwd: temp.path(),
				env: {
					PATH: Bun.env.PATH,
					HOME: temp.join("home"),
					PI_CODING_AGENT_DIR: temp.join("agent"),
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					XDG_CACHE_HOME: temp.join("cache"),
					CI: "true",
					PI_NO_TITLE: "1",
					OPENAI_API_KEY: "sk-env-fixture",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 20_000,
			},
		);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC login fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const frames = readJsonl<unknown>(stdout)[Symbol.asyncIterator]();
		const seen: string[] = [];
		const uiRequests: Record<string, unknown>[] = [];
		let nextId = 0;
		// Sends one command and answers its `input` requests with `answer(title)` until the response arrives.
		const request = async (
			frame: Record<string, unknown>,
			answer: (title: string) => string = () => "",
		): Promise<Record<string, unknown>> => {
			const id = `r${nextId++}`;
			child.stdin.write(`${JSON.stringify({ ...frame, id })}\n`);
			await child.stdin.flush();
			for (;;) {
				const next = await frames.next();
				if (next.done) throw new Error(`RPC child closed stdout: ${await stderr}`);
				const value = next.value;
				seen.push(JSON.stringify(value));
				if (!isRecord(value)) continue;
				if (value.type === "extension_ui_request") {
					// Startup widgets are not part of the login flow.
					if (value.method === "input" || value.method === "open_url") uiRequests.push(value);
					if (value.method === "input" && typeof value.id === "string" && typeof value.title === "string") {
						child.stdin.write(
							`${JSON.stringify({ type: "extension_ui_response", id: value.id, value: answer(value.title) })}\n`,
						);
						await child.stdin.flush();
					}
				} else if (value.type === "response" && value.id === id) {
					return value;
				}
			}
		};
		const providerById = (response: Record<string, unknown>, providerId: string): unknown => {
			const providers =
				isRecord(response.data) && Array.isArray(response.data.providers) ? response.data.providers : [];
			return providers.find(provider => isRecord(provider) && provider.id === providerId);
		};

		try {
			// Prompts before the auth URL now reach the host; the secret one carries `secret: true`.
			const preUrl = await request({ type: "login", providerId: "rpc-preurl", secretInput: true }, title =>
				title === "Endpoint?" ? "eu" : "pre-url-secret-key",
			);
			expect(preUrl).toMatchObject({ command: "login", success: true, data: { providerId: "rpc-preurl" } });
			expect(uiRequests.map(req => [req.method, req.title, req.secret])).toEqual([
				["input", "Endpoint?", undefined],
				["open_url", undefined, undefined],
				["input", "Key?", true],
			]);

			// `input` answers the first prompt in the command: no UI request, no masking declaration needed.
			uiRequests.length = 0;
			const keyFlow = await request({ type: "login", providerId: "rpc-keyflow", input: "keyflow-secret-key" });
			expect(keyFlow).toMatchObject({ command: "login", success: true });
			expect(uiRequests).toEqual([]);

			// Without `input` or `secretInput` a secret prompt fails instead of reaching an unmasked host.
			const unmasked = await request({ type: "login", providerId: "rpc-keyflow" });
			expect(unmasked).toMatchObject({
				success: false,
				error: expect.stringContaining("requires secret input"),
			});
			expect(uiRequests).toEqual([]);

			const before = await request({ type: "get_login_providers" });
			expect(providerById(before, "openai")).toEqual({
				id: "openai",
				name: "OpenAI",
				available: true,
				authenticated: true,
				apiKey: true,
				source: "env",
				envVar: "OPENAI_API_KEY",
			});
			expect(providerById(before, "groq")).toMatchObject({ apiKey: true, authenticated: false });
			expect(providerById(before, "groq")).not.toHaveProperty("source");
			expect(providerById(before, "cerebras")).toMatchObject({ apiKey: true });
			expect(providerById(before, "anthropic")).toMatchObject({ apiKey: false });
			expect(providerById(before, "rpc-keyflow")).toMatchObject({ authenticated: true, source: "api_key" });
			// Ambient-credential providers take no pasted key, so they are not listed.
			expect(providerById(before, "amazon-bedrock")).toBeUndefined();

			// An API-key provider without a login flow stores the key `input` carries.
			const groq = await request({ type: "login", providerId: "groq", input: "  gsk-groq-secret-key  " });
			expect(groq).toMatchObject({ command: "login", success: true, data: { providerId: "groq" } });
			const after = await request({ type: "get_login_providers" });
			expect(providerById(after, "groq")).toMatchObject({ authenticated: true, source: "api_key" });

			// Without `input`, the key is asked for through a masked `input` request.
			uiRequests.length = 0;
			const mistral = await request(
				{ type: "login", providerId: "mistral", secretInput: true },
				() => "mistral-secret-key",
			);
			expect(mistral).toMatchObject({ success: true });
			expect(uiRequests).toEqual([
				expect.objectContaining({ method: "input", title: "Paste your Mistral API key", secret: true }),
			]);
			const empty = await request({ type: "login", providerId: "aimlapi", input: "   " });
			expect(empty).toMatchObject({ success: false, error: "No API key entered for AIML API" });
			const unknown = await request({ type: "login", providerId: "no-such-provider", input: "x" });
			expect(unknown).toMatchObject({ success: false, error: "Unknown login provider: no-such-provider" });

			const accounts = await request({ type: "get_logout_accounts", providerId: "groq" });
			// Read before asserting: bun's asymmetric `toMatchObject` leaves matched array entries empty.
			const credentialId =
				isRecord(accounts.data) && Array.isArray(accounts.data.accounts) && isRecord(accounts.data.accounts[0])
					? accounts.data.accounts[0].credentialId
					: undefined;
			expect(accounts).toMatchObject({
				success: true,
				data: { accounts: [expect.objectContaining({ provider: "groq", type: "api_key", active: true })] },
			});
			const logout = await request({ type: "logout", providerId: "groq", credentialId });
			expect(logout).toMatchObject({ command: "logout", success: true });
			const loggedOut = await request({ type: "get_login_providers" });
			expect(providerById(loggedOut, "groq")).toMatchObject({ authenticated: false });
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		// Keys travel host → omp only: no frame or log line echoes them back.
		const output = `${seen.join("\n")}\n${await stderr}`;
		for (const key of ["pre-url-secret-key", "keyflow-secret-key", "gsk-groq-secret-key", "mistral-secret-key"]) {
			expect(output).not.toContain(key);
		}
	}, 30_000);
});

describe("RPC ask dialog", () => {
	it("sends every question in one ask frame and returns the validated answers", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion, featuresQuestion]);
		const request = requireRequest(output.mock.calls[0]?.[0]);

		expect(output).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: request.id,
			method: "ask",
			questions: [dbQuestion, featuresQuestion],
			timeout: undefined,
		});

		respond(pendingRequests, request.id, {
			answers: [
				{ id: "db", selectedOptions: ["Postgres"], customInput: "   " },
				{ id: "features", selectedOptions: ["Search", "Auth"], customInput: "  Export  " },
			],
		});
		expect(await result).toEqual({
			kind: "submit",
			results: [
				{
					id: "db",
					question: "Which database?",
					options: ["Postgres", "SQLite"],
					multi: false,
					selectedOptions: ["Postgres"],
					customInput: undefined,
				},
				{
					id: "features",
					question: "Which features?",
					options: ["Auth", "Billing", "Search"],
					multi: true,
					selectedOptions: ["Search", "Auth"],
					customInput: "Export",
				},
			],
		});
	});

	const validDb = { id: "db", selectedOptions: ["Postgres"] };
	const validFeatures = { id: "features", selectedOptions: ["Auth"] };
	it.each([
		["too few answers", [validDb]],
		["answers out of question order", [validFeatures, validDb]],
		["an unknown option label", [{ id: "db", selectedOptions: ["MySQL"] }, validFeatures]],
		["a duplicated option", [validDb, { id: "features", selectedOptions: ["Auth", "Auth"] }]],
		["two options on a single-select", [{ id: "db", selectedOptions: ["Postgres", "SQLite"] }, validFeatures]],
		[
			"an option plus custom input on a single-select",
			[{ id: "db", selectedOptions: ["Postgres"], customInput: "DuckDB" }, validFeatures],
		],
	])("rejects %s", async (_case, answers) => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion, featuresQuestion]);

		respond(pendingRequests, requireRequest(output.mock.calls[0]?.[0]).id, { answers });

		await expect(result).rejects.toThrow(Error);
		expect(pendingRequests.size).toBe(0);
	});

	it.each([
		["omp's timer fires", 5, undefined],
		["the host reports its own timeout", undefined, { cancelled: true, timedOut: true }],
	])("answers every question with its recommended option when %s", async (_case, timeout, response) => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const onTimeout = vi.fn();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion, featuresQuestion], {
			timeout,
			onTimeout,
		});
		if (response) respond(pendingRequests, requireRequest(output.mock.calls[0]?.[0]).id, response);

		expect(await result).toEqual({
			kind: "submit",
			results: [
				{
					id: "db",
					question: "Which database?",
					options: ["Postgres", "SQLite"],
					multi: false,
					selectedOptions: ["SQLite"],
					customInput: undefined,
					timedOut: true,
				},
				{
					id: "features",
					question: "Which features?",
					options: ["Auth", "Billing", "Search"],
					multi: true,
					selectedOptions: ["Auth"],
					customInput: undefined,
					timedOut: true,
				},
			],
		});
		expect(onTimeout).toHaveBeenCalledTimes(1);
		// omp settled the dialog; only its own timer must tell the host to close it.
		const request = requireRequest(output.mock.calls[0]?.[0]);
		const cancels = output.mock.calls
			.map(([frame]) => frame)
			.filter(frame => "method" in frame && frame.method === "cancel");
		expect(cancels).toEqual(
			timeout === undefined ? [] : [expect.objectContaining({ method: "cancel", targetId: request.id })],
		);
	});

	it("resolves a plain host cancel as a cancelled dialog", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const onTimeout = vi.fn();
		const result = requestRpcAskDialog(pendingRequests, output, [dbQuestion], { onTimeout });

		respond(pendingRequests, requireRequest(output.mock.calls[0]?.[0]).id, { cancelled: true });

		expect(await result).toBeUndefined();
		expect(onTimeout).not.toHaveBeenCalled();
	});

	it("keeps select prompts until the host opts in, then sends each ask as one dialog", async () => {
		await using temp = await TempDir.create("@rpc-ask-dialog-");
		const extensionPath = temp.join("scripted-ask.ts");
		await Bun.write(extensionPath, scriptedAskProvider);
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "..", "src", "cli.ts"),
				"--trusted-extension",
				extensionPath,
				"--mode",
				"rpc-ui",
				"--no-session",
			],
			{
				cwd: temp.path(),
				env: {
					PATH: Bun.env.PATH,
					HOME: temp.join("home"),
					PI_CODING_AGENT_DIR: temp.join("agent"),
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					XDG_CACHE_HOME: temp.join("cache"),
					CI: "true",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 30_000,
			},
		);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC ask fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		const selectRequests: Record<string, unknown>[] = [];
		const askRequests: Record<string, unknown>[] = [];
		const toolResults: unknown[] = [];
		let optInResponse: unknown;
		let finished = false;

		try {
			// The provider exists only once the extension loads, so select it over RPC.
			await send({ type: "set_model", id: "model", provider: "scripted", modelId: "ask" });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "response" && frame.id === "model") {
					if (frame.success !== true) throw new Error(`Scripted model unavailable: ${JSON.stringify(frame)}`);
					await send({ type: "prompt", id: "fallback", message: JSON.stringify({ questions: [dbQuestion] }) });
				} else if (frame.type === "extension_ui_request" && frame.method === "select") {
					selectRequests.push(frame);
					await send({ type: "extension_ui_response", id: frame.id, value: "Postgres" });
				} else if (frame.type === "extension_ui_request" && frame.method === "ask") {
					askRequests.push(frame);
					await send({
						type: "extension_ui_response",
						id: frame.id,
						answers: [
							{ id: "db", selectedOptions: [], customInput: "DuckDB" },
							{ id: "features", selectedOptions: ["Auth", "Search"] },
						],
					});
				} else if (frame.type === "tool_execution_end" && frame.toolName === "ask") {
					toolResults.push(frame.result);
				} else if (frame.type === "prompt_result" && frame.id === "fallback") {
					await send({ type: "set_ask_dialog", id: "opt-in", enabled: true });
				} else if (frame.type === "response" && frame.id === "opt-in") {
					optInResponse = frame;
					await send({
						type: "prompt",
						id: "dialog",
						message: JSON.stringify({ questions: [dbQuestion, featuresQuestion] }),
					});
				} else if (frame.type === "prompt_result" && frame.id === "dialog") {
					finished = true;
					break;
				}
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		if (!finished) throw new Error(`RPC ask fixture did not finish: ${await stderr}`);
		await stderr;
		expect(selectRequests).toHaveLength(1);
		expect(selectRequests[0]).toMatchObject({ method: "select", title: "Which database?" });
		expect(optInResponse).toEqual({
			id: "opt-in",
			type: "response",
			command: "set_ask_dialog",
			success: true,
			data: { enabled: true },
		});
		expect(askRequests).toEqual([
			{
				type: "extension_ui_request",
				id: expect.any(String),
				method: "ask",
				questions: [dbQuestion, featuresQuestion],
			},
		]);
		expect(toolResults).toEqual([
			expect.objectContaining({ details: expect.objectContaining({ selectedOptions: ["Postgres"] }) }),
			expect.objectContaining({
				details: {
					results: [
						expect.objectContaining({ id: "db", selectedOptions: [], customInput: "DuckDB" }),
						expect.objectContaining({ id: "features", selectedOptions: ["Auth", "Search"] }),
					],
				},
			}),
		]);
	}, 60_000);
});
