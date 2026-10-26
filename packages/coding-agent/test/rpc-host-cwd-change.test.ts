/**
 * `set_host_cwd_change` routes `/wt` and `/move` through the RPC host: each emits a
 * `host_cwd_change_request`, and the session moves into the directory the host accepts with,
 * or stays put when the host rejects. Drives the real CLI over raw JSONL; the session's actual
 * directory is read back through the `bash` RPC command (`pwd`), which runs in the session cwd.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";

const CLI = path.join(import.meta.dir, "../src/cli.ts");
const decoder = new TextDecoder();

type Frame = Record<string, unknown>;
/** Host reply to a `host_cwd_change_request`, minus `type` and `id`. */
type HostReply = { accepted: boolean; cwd?: string; error?: string };

interface Waiter {
	match: (frame: Frame) => boolean;
	resolve: (frame: Frame) => void;
}

/** One `omp --mode rpc` process; cwd change requests are recorded and answered by `reply`. */
class RpcHarness {
	readonly cwdRequests: Frame[] = [];
	readonly output: string[] = [];
	reply: (request: Frame) => HostReply = () => ({ accepted: false, error: "no reply configured" });
	readonly #dir: TempDir;
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #stderr: Promise<string>;
	#waiters: Waiter[] = [];
	#nextId = 0;

	private constructor(dir: TempDir, child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
		this.#dir = dir;
		this.#child = child;
		this.#stderr = new Response(child.stderr).text();
	}

	/** Real path of the temp root; the process starts in `<root>/project`. */
	get root(): string {
		return fs.realpathSync(this.#dir.path());
	}

	static async start(): Promise<RpcHarness> {
		const dir = TempDir.createSync("@omp-rpc-host-cwd-");
		const home = dir.path();
		const agentDir = path.join(home, ".omp/agent");
		const project = path.join(home, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(project);
		// No model call happens: `/wt` and `/move` are local builtins. The provider only has to resolve.
		await Bun.write(
			path.join(agentDir, "models.yml"),
			[
				"providers:",
				"  fake:",
				"    baseUrl: http://127.0.0.1:9/v1",
				"    auth: none",
				"    api: openai-completions",
				"    models:",
				"      - id: fake-model",
				"        name: Fake Model",
				"        reasoning: false",
				"",
			].join("\n"),
		);
		const child = Bun.spawn(
			[
				process.execPath,
				CLI,
				"--mode",
				"rpc",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--model",
				"fake/fake-model",
			],
			{
				cwd: project,
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
		const harness = new RpcHarness(dir, child);
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
			if (frame.type === "host_cwd_change_request") {
				// Real path, so it compares with `pwd -P` on macOS (/var → /private/var).
				this.cwdRequests.push({ ...frame, cwd: fs.realpathSync(String(frame.cwd)) });
				this.#write({ type: "host_cwd_change_result", id: frame.id, ...this.reply(frame) });
			}
			if (frame.type === "command_output") this.output.push(String(frame.text));
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

	/** Successful response `data` of one command. */
	async data(command: Frame): Promise<unknown> {
		const id = `c${++this.#nextId}`;
		const response = this.#waitFor(frame => frame.type === "response" && frame.id === id);
		this.#write({ ...command, id });
		const frame = await response;
		if (frame.success !== true) throw new Error(`${String(command.type)} failed: ${String(frame.error)}`);
		return frame.data;
	}

	/** Run a local slash command and return the `command_output` it produced before completing. */
	async slash(text: string): Promise<string> {
		const id = `p${++this.#nextId}`;
		const before = this.output.length;
		// A builtin that starts no turn completes with its `prompt` response (`agentInvoked: false`).
		const response = this.#waitFor(frame => frame.type === "response" && frame.id === id);
		this.#write({ type: "prompt", id, message: text });
		expect(await response).toMatchObject({ success: true, data: { agentInvoked: false } });
		return this.output.slice(before).join("\n");
	}

	/** The session's working directory, as the shell the session spawns sees it. */
	async cwd(): Promise<string> {
		const result = (await this.data({ type: "bash", command: "pwd -P" })) as { output: string };
		return result.output.trim();
	}

	async stop(): Promise<void> {
		this.#child.kill();
		await this.#child.exited;
		await this.#stderr;
		await this.#dir.remove();
	}
}

let harness: RpcHarness | undefined;

afterEach(async () => {
	await harness?.stop();
	harness = undefined;
});

describe("RPC host_cwd_change_request", () => {
	test("/wt asks the host for the worktree and follows its reply", async () => {
		harness = await RpcHarness.start();
		const h = harness;
		const project = path.join(h.root, "project");
		const hostWorktree = path.join(h.root, "host-worktree");
		fs.mkdirSync(hostWorktree);

		expect(await h.data({ type: "set_host_cwd_change", enabled: true })).toEqual({ enabled: true });

		h.reply = () => ({ accepted: false, error: "worktree manager is busy" });
		expect(await h.slash("/wt feature/rejected")).toContain(
			"Worktree creation rejected by host: worktree manager is busy",
		);
		expect(h.cwdRequests.at(-1)).toMatchObject({ reason: "worktree", cwd: project, branch: "feature/rejected" });
		expect(await h.cwd()).toBe(project);

		h.reply = () => ({ accepted: true });
		expect(await h.slash("/wt feature/no-dir")).toContain(
			"Worktree creation failed: Host accepted the worktree request without a directory",
		);
		expect(await h.cwd()).toBe(project);

		const listing = fs.readdirSync(h.root).sort();
		h.reply = () => ({ accepted: true, cwd: hostWorktree });
		expect(await h.slash("/wt feature/accepted")).toContain(`Moved to worktree ${hostWorktree}.`);
		expect(h.cwdRequests.at(-1)).toMatchObject({ reason: "worktree", cwd: project, branch: "feature/accepted" });
		expect(await h.cwd()).toBe(hostWorktree);
		// The host made the worktree: OMP created no directory of its own.
		expect(fs.readdirSync(h.root).sort()).toEqual(listing);
	}, 120_000);

	test("/move asks the host and honours accept, redirect, and reject", async () => {
		harness = await RpcHarness.start();
		const h = harness;
		const project = path.join(h.root, "project");
		const target = path.join(h.root, "target");
		const redirect = path.join(h.root, "redirect");
		fs.mkdirSync(target);
		fs.mkdirSync(redirect);

		expect(await h.data({ type: "set_host_cwd_change", enabled: true })).toEqual({ enabled: true });

		h.reply = () => ({ accepted: false, error: "thread is pinned to its project" });
		expect(await h.slash(`/move ${target}`)).toContain("Move rejected by host: thread is pinned to its project");
		expect(h.cwdRequests.at(-1)).toMatchObject({ reason: "move", cwd: project, path: target });
		expect(await h.cwd()).toBe(project);

		h.reply = () => ({ accepted: true });
		expect(await h.slash(`/move ${target}`)).toContain(`Moved to ${target}.`);
		expect(await h.cwd()).toBe(target);

		h.reply = () => ({ accepted: true, cwd: redirect });
		expect(await h.slash(`/move ${project}`)).toContain(`Moved to ${redirect}.`);
		expect(h.cwdRequests.at(-1)).toMatchObject({ reason: "move", cwd: target, path: project });
		expect(await h.cwd()).toBe(redirect);

		h.reply = () => ({ accepted: true, cwd: "relative/dir" });
		expect(await h.slash(`/move ${project}`)).toContain(
			"Move failed: host returned a relative directory: relative/dir",
		);
		expect(await h.cwd()).toBe(redirect);
	}, 120_000);

	test("without set_host_cwd_change, or after disabling it, /move never asks the host", async () => {
		harness = await RpcHarness.start();
		const h = harness;
		const target = path.join(h.root, "target");
		fs.mkdirSync(target);

		expect(await h.slash(`/move ${target}`)).toContain(`Moved to ${target}.`);
		expect(await h.cwd()).toBe(target);

		expect(await h.data({ type: "set_host_cwd_change", enabled: true })).toEqual({ enabled: true });
		expect(await h.data({ type: "set_host_cwd_change", enabled: false })).toEqual({ enabled: false });
		const project = path.join(h.root, "project");
		expect(await h.slash(`/move ${project}`)).toContain(`Moved to ${project}.`);
		expect(await h.cwd()).toBe(project);
		expect(h.cwdRequests).toEqual([]);
	}, 120_000);
});
