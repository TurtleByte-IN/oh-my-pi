/**
 * `resolve_proposal` applies or discards a staged `ast_edit` preview on the user's behalf.
 * Drives the real CLI over raw JSONL against the scripted OpenAI-compatible server: the model
 * stages a real `ast_edit` proposal, the server holds its next answer, and the host resolves
 * the proposal while the turn runs (or after it was aborted).
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";

const CLI = path.join(import.meta.dir, "../src/cli.ts");
const FAKE_SERVER = path.join(import.meta.dir, "rpc-wire/fake-openai-server.ts");
const decoder = new TextDecoder();

/** The fake server names each tool call `call_<tool>`. */
const AST_EDIT_CALL = "call_ast_edit";

type Frame = Record<string, unknown>;

interface Waiter {
	match: (frame: Frame) => boolean;
	resolve: (frame: Frame) => void;
}

/** One `omp --mode rpc` process on the fake model, in yolo mode so tools run without asking. */
class RpcHarness {
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

	get agentDir(): string {
		return path.join(this.home, ".omp/agent");
	}

	static async start(): Promise<RpcHarness> {
		const dir = TempDir.createSync("@omp-rpc-resolve-proposal-");
		const home = dir.path();
		const agentDir = path.join(home, ".omp/agent");
		fs.mkdirSync(agentDir, { recursive: true });
		const server = Bun.spawn([process.execPath, FAKE_SERVER, agentDir], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});
		let port: string | undefined;
		for await (const line of readLines(server.stdout, AbortSignal.timeout(30_000))) {
			port = /^READY (\d+)/.exec(decoder.decode(line))?.[1];
			if (port) break;
		}
		if (!port) throw new Error("fake OpenAI server did not start");
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
				"--approval-mode",
				"yolo",
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
		const ready = harness.waitFor(frame => frame.type === "ready");
		void harness.#pump();
		await ready;
		return harness;
	}

	async #pump(): Promise<void> {
		for await (const line of readLines(this.#child.stdout)) {
			const text = decoder.decode(line).trim();
			if (!text.startsWith("{")) continue;
			const frame = JSON.parse(text) as Frame;
			const waiter = this.#waiters.find(entry => entry.match(frame));
			if (waiter) {
				this.#waiters = this.#waiters.filter(entry => entry !== waiter);
				waiter.resolve(frame);
			}
		}
	}

	write(frame: Frame): void {
		this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
		this.#child.stdin.flush();
	}

	/** Resolve with the first frame `match` accepts; the deadline only bounds a hung server. */
	waitFor(match: (frame: Frame) => boolean, timeoutMs = 60_000): Promise<Frame> {
		const { promise, resolve, reject } = Promise.withResolvers<Frame>();
		const waiter: Waiter = { match, resolve };
		this.#waiters.push(waiter);
		AbortSignal.timeout(timeoutMs).addEventListener("abort", () => {
			this.#waiters = this.#waiters.filter(entry => entry !== waiter);
			reject(new Error("timed out waiting for an RPC frame"));
		});
		return promise;
	}

	async request(command: Frame): Promise<Frame> {
		const id = `c${++this.#nextId}`;
		const response = this.waitFor(frame => frame.type === "response" && frame.id === id);
		this.write({ ...command, id });
		return response;
	}

	async data(command: Frame): Promise<unknown> {
		const response = await this.request(command);
		if (response.success !== true) throw new Error(`${String(command.type)} failed: ${String(response.error)}`);
		return response.data;
	}

	/**
	 * Prompt the scripted model to stage an `ast_edit` of `file`; resolves once the preview is
	 * staged, with the prompt's eventual `prompt_result` as `turn` (wrapped, so awaiting the
	 * staging does not await the turn). The model's next answer is held until `releaseModel()`.
	 */
	async stageProposal(file: string, pattern: string, replacement: string): Promise<{ readonly turn: Promise<Frame> }> {
		const id = `p${++this.#nextId}`;
		const turn = this.waitFor(frame => frame.type === "prompt_result" && frame.id === id);
		const staged = this.waitFor(frame => frame.type === "tool_execution_end" && frame.toolCallId === AST_EDIT_CALL);
		this.write({ type: "prompt", id, message: `ast_edit_uri ${file} ${pattern} ${replacement}` });
		const end = await staged;
		expect(end.isError).not.toBe(true);
		expect(JSON.stringify(end.result)).toContain("Staged as a proposal");
		return { turn };
	}

	releaseModel(): void {
		fs.writeFileSync(path.join(this.agentDir, "release-proposal"), "");
	}

	async customMessages(customType: string): Promise<Frame[]> {
		const { messages } = (await this.data({ type: "get_messages" })) as { messages: Frame[] };
		return messages.filter(message => message.role === "custom" && message.customType === customType);
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

describe("RPC resolve_proposal", () => {
	test("applies the proposal a tool call staged while the turn runs, and tells the agent", async () => {
		harness = await RpcHarness.start();
		const file = path.join(harness.home, "sample.ts");
		await Bun.write(file, "const foo = 1;\nexport { foo };\n");

		const { turn } = await harness.stageProposal(file, "foo", "bar");
		// Staged, not written.
		expect(fs.readFileSync(file, "utf8")).toBe("const foo = 1;\nexport { foo };\n");

		const resolved = (await harness.data({
			type: "resolve_proposal",
			action: "apply",
			toolCallId: AST_EDIT_CALL,
		})) as Record<string, unknown>;
		expect(resolved).toMatchObject({
			action: "apply",
			sourceToolName: "ast_edit",
			toolCallId: AST_EDIT_CALL,
			isError: false,
		});
		expect(String(resolved.label)).toContain("AST Edit: 2 replacements in 1 file");
		expect(String(resolved.text)).toContain("Applied 2 replacements in 1 file.");
		expect(resolved.details).toMatchObject({ applied: true, totalReplacements: 2 });
		expect(fs.readFileSync(file, "utf8")).toBe("const bar = 1;\nexport { bar };\n");

		// Consumed exactly once: the agent's own resolve, or a second click, finds nothing.
		const again = await harness.request({ type: "resolve_proposal", action: "apply", toolCallId: AST_EDIT_CALL });
		expect(again).toMatchObject({
			success: false,
			error: `No staged proposal from tool call ${AST_EDIT_CALL} is pending.`,
		});

		harness.releaseModel();
		expect(await turn).toMatchObject({ status: "completed" });
		const [note] = await harness.customMessages("proposal-resolved");
		expect(String(note?.content)).toContain("The user applied AST Edit: 2 replacements in 1 file");
		expect(String(note?.content)).toContain("Reason: The user accepted the proposal.");
	}, 120_000);

	test("discards the latest proposal after the turn was stopped", async () => {
		harness = await RpcHarness.start();
		const file = path.join(harness.home, "sample.ts");
		await Bun.write(file, "const foo = 1;\n");

		const { turn } = await harness.stageProposal(file, "foo", "bar");
		await harness.data({ type: "abort" });
		expect(await turn).toMatchObject({ status: "aborted" });

		const resolved = await harness.data({
			type: "resolve_proposal",
			action: "discard",
			reason: "Keep the old name.",
		});
		expect(resolved).toMatchObject({
			action: "discard",
			sourceToolName: "ast_edit",
			toolCallId: AST_EDIT_CALL,
			isError: false,
		});
		expect(fs.readFileSync(file, "utf8")).toBe("const foo = 1;\n");
		const [note] = await harness.customMessages("proposal-resolved");
		expect(String(note?.content)).toContain("The user discarded AST Edit: 1 replacement in 1 file");
		expect(String(note?.content)).toContain("Reason: Keep the old name.");

		const none = await harness.request({ type: "resolve_proposal", action: "discard" });
		expect(none).toMatchObject({ success: false, error: "No staged proposal is pending." });
	}, 120_000);

	test("refuses a malformed command", async () => {
		harness = await RpcHarness.start();
		expect(await harness.request({ type: "resolve_proposal", action: "maybe" })).toMatchObject({
			success: false,
			error: "`action` must be `apply` or `discard`.",
		});
		expect(await harness.request({ type: "resolve_proposal", action: "apply", toolCallId: "" })).toMatchObject({
			success: false,
			error: "`toolCallId` must be a non-empty string when given.",
		});
	}, 60_000);
});
