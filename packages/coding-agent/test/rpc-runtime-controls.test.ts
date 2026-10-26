/**
 * `set_approval_mode`, `set_advisor`, `set_prewalk`, and `set_tool_enabled` change a running
 * `omp --mode rpc` without a restart. Drives the real CLI over raw JSONL against the scripted
 * OpenAI-compatible server, so the approval checks observe the actual gate: an approval prompt
 * arrives as an `extension_ui_request`, and the scripted `write` either lands on disk or not.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";

const CLI = path.join(import.meta.dir, "../src/cli.ts");
const FAKE_SERVER = path.join(import.meta.dir, "rpc-wire/fake-openai-server.ts");
const decoder = new TextDecoder();

const DIALOG_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true, ask: true };

type Frame = Record<string, unknown>;

interface Waiter {
	match: (frame: Frame) => boolean;
	resolve: (frame: Frame) => void;
}

/** One `omp --mode rpc` process on the fake model; extension UI requests are recorded and cancelled. */
class RpcHarness {
	readonly uiRequests: Frame[] = [];
	readonly #dir: TempDir;
	readonly #server: Bun.Subprocess<"pipe", "pipe", "inherit">;
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #stderr: Promise<string>;
	#waiters: Waiter[] = [];
	#nextId = 0;

	private constructor(
		dir: TempDir,
		server: Bun.Subprocess<"pipe", "pipe", "inherit">,
		child: Bun.Subprocess<"pipe", "pipe", "pipe">,
	) {
		this.#dir = dir;
		this.#server = server;
		this.#child = child;
		this.#stderr = new Response(child.stderr).text();
	}

	get home(): string {
		return this.#dir.path();
	}

	/** `modelRoles` lines for config.yml; `fake/fake-smol` is a second model on the fake provider. */
	static async start(flags: string[], modelRoles: Record<string, string> = {}): Promise<RpcHarness> {
		const dir = TempDir.createSync("@omp-rpc-runtime-controls-");
		const home = dir.path();
		const agentDir = path.join(home, ".omp/agent");
		fs.mkdirSync(agentDir, { recursive: true });
		const server = Bun.spawn([process.execPath, FAKE_SERVER, agentDir], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});
		const serverLines = readLines(server.stdout, AbortSignal.timeout(30_000));
		let port: string | undefined;
		for await (const line of serverLines) {
			port = /^READY (\d+)/.exec(decoder.decode(line))?.[1];
			if (port) break;
		}
		if (!port) throw new Error("fake OpenAI server did not start");
		await Bun.write(
			path.join(agentDir, "models.yml"),
			[
				"providers:",
				"  fake:",
				`    baseUrl: http://127.0.0.1:${port}/v1`,
				"    auth: none",
				"    api: openai-completions",
				"    models:",
				"      - id: fake-model",
				"        name: Fake Model",
				"        reasoning: false",
				"      - id: fake-smol",
				"        name: Fake Smol",
				"        reasoning: false",
				"",
			].join("\n"),
		);
		const roles = Object.entries(modelRoles);
		if (roles.length > 0) {
			await Bun.write(
				path.join(agentDir, "config.yml"),
				["modelRoles:", ...roles.map(([role, model]) => `  ${role}: ${model}`), ""].join("\n"),
			);
		}
		const child = Bun.spawn(
			[
				process.execPath,
				CLI,
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--model",
				"fake/fake-model",
				...flags,
			],
			{
				cwd: home,
				env: {
					HOME: home,
					PATH: process.env.PATH,
					XDG_CONFIG_HOME: home,
					XDG_DATA_HOME: home,
					PI_CODING_AGENT_DIR: agentDir,
					PI_NO_TITLE: "1",
					NO_COLOR: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const harness = new RpcHarness(dir, server, child);
		const ready = harness.#waitFor(frame => frame.type === "ready");
		void harness.#pump();
		await ready;
		return harness;
	}

	async #pump(): Promise<void> {
		for await (const line of readLines(this.#child.stdout)) {
			const text = decoder.decode(line).trim();
			if (!text.startsWith("{")) continue;
			const frame = JSON.parse(text) as Frame;
			// Dialogs wait for an answer; status, title, and notify requests are fire-and-forget.
			if (frame.type === "extension_ui_request" && DIALOG_METHODS[String(frame.method)] === true) {
				this.uiRequests.push(frame);
				this.#write({ type: "extension_ui_response", id: frame.id, cancelled: true });
			}
			const waiter = this.#waiters.find(entry => entry.match(frame));
			if (waiter) {
				this.#waiters = this.#waiters.filter(entry => entry !== waiter);
				waiter.resolve(frame);
			}
		}
	}

	#write(frame: Frame): void {
		this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
		this.#child.stdin.flush();
	}

	/** Resolve with the first frame `match` accepts; the deadline only bounds a hung server. */
	#waitFor(match: (frame: Frame) => boolean, timeoutMs = 30_000): Promise<Frame> {
		const { promise, resolve, reject } = Promise.withResolvers<Frame>();
		const waiter: Waiter = { match, resolve };
		this.#waiters.push(waiter);
		AbortSignal.timeout(timeoutMs).addEventListener("abort", () => {
			this.#waiters = this.#waiters.filter(entry => entry !== waiter);
			reject(new Error("timed out waiting for an RPC frame"));
		});
		return promise;
	}

	/** Send one command and return its `response` frame. */
	async request(command: Frame): Promise<Frame> {
		const id = `c${++this.#nextId}`;
		const response = this.#waitFor(frame => frame.type === "response" && frame.id === id);
		this.#write({ ...command, id });
		return response;
	}

	/** Successful response `data` of one command. */
	async data(command: Frame): Promise<unknown> {
		const response = await this.request(command);
		if (response.success !== true) throw new Error(`${String(command.type)} failed: ${String(response.error)}`);
		return response.data;
	}

	/** Prompt and wait for its `prompt_result`. */
	async prompt(message: string): Promise<Frame> {
		const id = `p${++this.#nextId}`;
		const result = this.#waitFor(frame => frame.type === "prompt_result" && frame.id === id, 60_000);
		this.#write({ type: "prompt", id, message });
		return result;
	}

	/** Prompt the scripted model to `write` `file` under the temp home; reports whether a prompt was raised and the file landed. */
	async scriptedWrite(file: string): Promise<{ asked: boolean; written: boolean }> {
		const before = this.uiRequests.length;
		const target = path.join(this.home, file);
		await this.prompt(`write_uri ${target}`);
		return { asked: this.uiRequests.length > before, written: fs.existsSync(target) };
	}

	async stop(): Promise<void> {
		this.#child.kill();
		await this.#child.exited;
		await this.#stderr;
		this.#server.stdin.end();
		this.#server.kill();
		await this.#server.exited;
		await this.#dir.remove();
	}
}

let harness: RpcHarness | undefined;

afterEach(async () => {
	await harness?.stop();
	harness = undefined;
});

describe("RPC runtime controls", () => {
	test("set_approval_mode changes the live approval gate and rejects unknown modes", async () => {
		harness = await RpcHarness.start(["--approval-mode", "always-ask"]);

		expect(await harness.scriptedWrite("ask-1.txt")).toEqual({ asked: true, written: false });
		expect(harness.uiRequests.at(-1)).toMatchObject({ method: "select" });
		expect(String(harness.uiRequests.at(-1)?.title)).toContain("Allow tool: write");

		const invalid = await harness.request({ type: "set_approval_mode", mode: "everything" });
		expect(invalid).toMatchObject({ success: false, error: "Invalid approval mode: everything" });
		// A rejected value must not fall through to the yolo default.
		expect(await harness.scriptedWrite("ask-2.txt")).toEqual({ asked: true, written: false });

		expect(await harness.data({ type: "set_approval_mode", mode: "yolo" })).toEqual({ mode: "yolo" });
		expect(await harness.scriptedWrite("yolo.txt")).toEqual({ asked: false, written: true });
		expect(await Bun.file(path.join(harness.home, "yolo.txt")).text()).toBe("written by model");

		expect(await harness.data({ type: "set_approval_mode", mode: "always-ask" })).toEqual({ mode: "always-ask" });
		expect(await harness.scriptedWrite("ask-3.txt")).toEqual({ asked: true, written: false });

		// Runtime override only: config.yml is never written.
		expect(fs.existsSync(path.join(harness.home, ".omp/agent/config.yml"))).toBe(false);
	}, 120_000);

	test("set_approval_mode cannot tighten a session launched with --auto-approve", async () => {
		harness = await RpcHarness.start(["--auto-approve"]);
		const locked = await harness.request({ type: "set_approval_mode", mode: "always-ask" });
		expect(locked).toMatchObject({
			success: false,
			error: "Approval mode is locked to yolo: the session was started with --auto-approve/--yolo.",
		});
		expect(await harness.data({ type: "set_approval_mode", mode: "yolo" })).toEqual({ mode: "yolo" });
	}, 60_000);

	test("set_tool_enabled removes and restores a tool in the running session", async () => {
		harness = await RpcHarness.start(["--approval-mode", "yolo"]);
		const h = harness;
		const toolNames = async () => {
			const state = (await h.data({ type: "get_state" })) as { dumpTools: Array<{ name: string }> };
			return state.dumpTools.map(tool => tool.name);
		};
		const note = path.join(h.home, "note.txt");
		await Bun.write(note, "hello from note");
		/** Prompt the scripted model to `read` the note; returns the tool result it got back. */
		const scriptedRead = async () => {
			await h.prompt(`read_uri ${note}`);
			const messages = (await h.data({ type: "get_messages" })) as { messages: Frame[] };
			const result = messages.messages.findLast(message => message.role === "toolResult");
			return { isError: result?.isError, text: JSON.stringify(result?.content) };
		};
		expect(await toolNames()).toContain("read");
		expect(await scriptedRead()).toMatchObject({ isError: false });

		expect(await h.data({ type: "set_tool_enabled", tool: "read", enabled: false })).toEqual({ enabled: false });
		expect(await toolNames()).not.toContain("read");
		const refused = await scriptedRead();
		expect(refused.isError).toBe(true);
		expect(refused.text).not.toContain("hello from note");

		expect(await h.data({ type: "set_tool_enabled", tool: "read", enabled: true })).toEqual({ enabled: true });
		expect(await toolNames()).toContain("read");
		expect(await scriptedRead()).toMatchObject({ isError: false });

		const unknown = await h.request({ type: "set_tool_enabled", tool: "no_such_tool", enabled: true });
		expect(unknown).toMatchObject({ success: false, error: "Unknown tool: no_such_tool" });
	}, 120_000);

	test("set_advisor and set_prewalk start and stop their runtimes", async () => {
		harness = await RpcHarness.start(["--approval-mode", "yolo"], {
			advisor: "fake/fake-model",
			smol: "fake/fake-smol",
		});

		expect(await harness.data({ type: "set_advisor", enabled: true })).toEqual({ enabled: true, active: true });
		expect(await harness.data({ type: "set_advisor", enabled: false })).toEqual({ enabled: false, active: false });
		const badAdvisor = await harness.request({ type: "set_advisor", enabled: "yes" });
		expect(badAdvisor).toMatchObject({ success: false, error: "set_advisor requires boolean enabled" });

		expect(await harness.data({ type: "set_prewalk", armed: true })).toEqual({
			armed: true,
			provider: "fake",
			modelId: "fake-smol",
		});
		expect(await harness.data({ type: "set_prewalk", armed: false })).toEqual({ armed: false });
	}, 60_000);

	test("set_advisor reports an inactive advisor when no advisor model is assigned", async () => {
		harness = await RpcHarness.start(["--approval-mode", "yolo"]);
		expect(await harness.data({ type: "set_advisor", enabled: true })).toEqual({ enabled: true, active: false });
	}, 60_000);

	test("get_state reports workspace trust and the browser and computer preludes", async () => {
		harness = await RpcHarness.start(["--approval-mode", "yolo"]);
		expect(await harness.data({ type: "get_state" })).toMatchObject({
			workspaceTrusted: true,
			computerEnabled: false,
		});
		await harness.stop();
		harness = undefined;

		// A host's `--config` overlay: the values a guard writes for an untrusted, supervised thread.
		const overlay = TempDir.createSync("@omp-rpc-overlay-");
		try {
			const file = path.join(overlay.path(), "thread.yml");
			await Bun.write(
				file,
				"workspace:\n  trusted: false\nbrowser:\n  enabled: false\ncomputer:\n  enabled: true\n",
			);
			harness = await RpcHarness.start(["--approval-mode", "yolo", "--config", file]);
			expect(await harness.data({ type: "get_state" })).toMatchObject({
				workspaceTrusted: false,
				browserEnabled: false,
				computerEnabled: true,
			});
		} finally {
			await overlay.remove();
		}
	}, 120_000);
});
