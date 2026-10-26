/**
 * RPC `set_vibe_mode`: an RPC host turns `/vibe` on and off with the TUI's lifecycle (tool
 * swap, plan/goal guards, worker teardown, reattach), `get_state` reports it, and vibe worker
 * frames name the `vibe_spawn` call that created the worker. Drives a real SDK session over
 * RPC (`fixtures/vibe-rpc-agent.ts`) whose director and workers run on one scripted model.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type {
	RpcSubagentLifecycleFrame,
	RpcSubagentProgressFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

/**
 * The rejection of a request to the RPC child, settled before `expect` sees it
 * (see rpc-goal.test.ts: `expect(pending).rejects` can stall on a live child request).
 */
async function rejectionOf(request: Promise<unknown>): Promise<unknown> {
	return await request.then(
		() => new Error("expected the request to fail"),
		(error: unknown) => error,
	);
}

async function activeTools(rpc: RpcClient): Promise<string[]> {
	return ((await rpc.getState()).dumpTools ?? []).map(tool => tool.name).toSorted();
}

describe("RPC set_vibe_mode", () => {
	let client: RpcClient | undefined;
	let directory: string | undefined;

	afterEach(async () => {
		await client?.stop();
		client = undefined;
		if (directory) await removeWithRetries(directory);
		directory = undefined;
	});

	async function start(options: {
		plan?: boolean;
		subagent?: boolean;
		persist?: boolean;
		sessionFile?: string;
		/** Working directory under the test directory; sessions are recorded with it. */
		subdirectory?: string;
	}): Promise<RpcClient> {
		directory ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-vibe-"));
		const cwd = options.subdirectory ? path.join(directory, options.subdirectory) : directory;
		await fs.mkdir(cwd, { recursive: true });
		await client?.stop();
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "vibe-rpc-agent.ts")],
			cwd,
			env: {
				HOME: directory,
				PI_CODING_AGENT_DIR: directory,
				PI_NO_TITLE: "1",
				VIBE_RPC_PLAN: options.plan ? "1" : "0",
				VIBE_RPC_SUBAGENT: options.subagent ? "1" : "0",
				VIBE_RPC_PERSIST: options.persist ? "1" : "0",
				...(options.sessionFile ? { VIBE_RPC_SESSION_FILE: options.sessionFile } : {}),
			},
		});
		await client.start();
		return client;
	}

	test("swaps in the director toolset and restores the previous one; repeating a call changes nothing", async () => {
		const rpc = await start({});
		const before = await activeTools(rpc);
		expect((await rpc.getState()).vibeModeEnabled).toBe(false);

		expect(await rpc.setVibeMode(true)).toEqual({ enabled: true, killed: 0 });
		const state = await rpc.getState();
		expect(state.vibeModeEnabled).toBe(true);
		const director = await activeTools(rpc);
		expect(director).toEqual(["read", "todo", ...VIBE_TOOL_NAMES].toSorted());

		expect(await rpc.setVibeMode(true)).toEqual({ enabled: true, killed: 0 });
		expect(await activeTools(rpc)).toEqual(director);

		expect(await rpc.setVibeMode(false)).toEqual({ enabled: false, killed: 0 });
		expect((await rpc.getState()).vibeModeEnabled).toBe(false);
		expect(await activeTools(rpc)).toEqual(before);
		expect(await rpc.setVibeMode(false)).toEqual({ enabled: false, killed: 0 });
	}, 30_000);

	test("plan mode refuses entry", async () => {
		const rpc = await start({ plan: true });
		const refused = await rejectionOf(rpc.setVibeMode(true));
		expect(refused).toMatchObject({ command: "set_vibe_mode", message: "Exit plan mode first." });
		expect((await rpc.getState()).vibeModeEnabled).toBe(false);
	}, 30_000);

	test("an active or paused goal refuses entry, and vibe mode refuses goal create and resume", async () => {
		const rpc = await start({});
		await rpc.goal("create", { objective: "ship it" });
		expect(await rejectionOf(rpc.setVibeMode(true))).toMatchObject({ message: "Exit goal mode first." });
		await rpc.goal("pause");
		expect(await rejectionOf(rpc.setVibeMode(true))).toMatchObject({ message: "Exit goal mode first." });
		await rpc.goal("drop");

		await rpc.setVibeMode(true);
		const exitVibe = { command: "goal", message: "Exit vibe mode first." };
		expect(await rejectionOf(rpc.goal("create", { objective: "not while vibing" }))).toMatchObject(exitVibe);
		expect(await rejectionOf(rpc.goal("resume"))).toMatchObject(exitVibe);
		expect((await rpc.getState()).goal).toBeNull();
	}, 30_000);

	test("a subagent session has no vibe tools and refuses entry", async () => {
		const rpc = await start({ subagent: true });
		const refused = await rejectionOf(rpc.setVibeMode(true));
		expect(refused).toMatchObject({ command: "set_vibe_mode" });
		expect((refused as Error).message).toContain("only a top-level session can direct workers");
		expect((await rpc.getState()).vibeModeEnabled).toBe(false);
	}, 30_000);

	test("worker frames carry the vibe_spawn call id on every turn; exit kills the worker", async () => {
		const rpc = await start({});
		await rpc.setSubagentSubscription("progress");
		const lifecycle: RpcSubagentLifecycleFrame["payload"][] = [];
		const progress: RpcSubagentProgressFrame["payload"][] = [];
		rpc.onSubagentLifecycle(payload => lifecycle.push(payload));
		rpc.onSubagentProgress(payload => progress.push(payload));
		await rpc.setVibeMode(true);

		await rpc.promptAndWait("spawn a worker");
		await rpc.waitForSettled();
		await rpc.promptAndWait("message the worker");
		await rpc.waitForSettled();

		const workerTurns = lifecycle.filter(payload => payload.id === "Worker1");
		expect(workerTurns.map(payload => payload.status)).toEqual(["started", "completed", "started", "completed"]);
		expect(workerTurns.map(payload => payload.parentToolCallId)).toEqual(Array(4).fill("spawn-call"));
		const workerProgress = progress.filter(payload => payload.progress.id === "Worker1");
		expect(workerProgress.length).toBeGreaterThan(0);
		expect(new Set(workerProgress.map(payload => payload.parentToolCallId))).toEqual(new Set(["spawn-call"]));

		expect(await rpc.setVibeMode(false)).toEqual({ enabled: false, killed: 1 });
		expect((await rpc.getState()).vibeModeEnabled).toBe(false);
	}, 60_000);

	test("vibe mode follows the journal across session switches and a restart; new_session is refused while on", async () => {
		let rpc = await start({ persist: true });
		await rpc.promptAndWait("hello");
		const vibeSession = (await rpc.getState()).sessionFile;
		if (!vibeSession) throw new Error("expected a persisted session");
		await rpc.setVibeMode(true);
		const refused = await rejectionOf(rpc.newSession());
		expect(refused).toMatchObject({ command: "new_session" });
		expect((refused as Error).message).toContain("Exit vibe mode first");

		await rpc.setVibeMode(false);
		await rpc.newSession();
		await rpc.promptAndWait("hello");
		const plainSession = (await rpc.getState()).sessionFile;
		if (!plainSession) throw new Error("expected a persisted session");
		const plainTools = await activeTools(rpc);
		await rpc.switchSession(vibeSession);
		await rpc.setVibeMode(true);

		// Leaving the vibe session drops vibe mode; coming back reattaches it.
		await rpc.switchSession(plainSession);
		expect((await rpc.getState()).vibeModeEnabled).toBe(false);
		expect(await activeTools(rpc)).toEqual(plainTools);
		await rpc.switchSession(vibeSession);
		expect((await rpc.getState()).vibeModeEnabled).toBe(true);
		expect(await activeTools(rpc)).toContain("vibe_spawn");

		// A process started on a session journaled in vibe mode starts in it.
		rpc = await start({ sessionFile: vibeSession });
		expect((await rpc.getState()).vibeModeEnabled).toBe(true);
		expect(await activeTools(rpc)).toContain("vibe_spawn");
		expect(await rpc.setVibeMode(false)).toEqual({ enabled: false, killed: 0 });
		expect(await activeTools(rpc)).not.toContain("vibe_spawn");
	}, 60_000);

	/** A persisted session in vibe mode with one idle worker, `Worker1`. */
	async function vibeSessionWithWorker(): Promise<{ rpc: RpcClient; sessionFile: string }> {
		const rpc = await start({ persist: true });
		await rpc.promptAndWait("hello");
		await rpc.setVibeMode(true);
		await rpc.promptAndWait("spawn a worker");
		await rpc.waitForSettled();
		const sessionFile = (await rpc.getState()).sessionFile;
		if (!sessionFile) throw new Error("expected a persisted session");
		return { rpc, sessionFile };
	}

	test("switching from a vibe session into a goal session keeps the goal tool and drops the vibe tools", async () => {
		const rpc = await start({ persist: true });
		await rpc.promptAndWait("hello");
		const plainTools = await activeTools(rpc);
		await rpc.goal("create", { objective: "ship it" });
		const goalSession = (await rpc.getState()).sessionFile;
		if (!goalSession) throw new Error("expected a persisted session");
		await rpc.newSession();
		await rpc.promptAndWait("hello");
		await rpc.setVibeMode(true);

		await rpc.switchSession(goalSession);
		const state = await rpc.getState();
		expect(state.vibeModeEnabled).toBe(false);
		expect(state.goal?.goal.objective).toBe("ship it");
		expect(await activeTools(rpc)).toEqual([...plainTools, "goal"].toSorted());
		// The goal's own snapshot is the pre-vibe set, so ending the goal restores it.
		await rpc.goal("drop");
		expect(await activeTools(rpc)).toEqual(plainTools);
	}, 60_000);

	test("reloading the open vibe session keeps vibe mode and its workers", async () => {
		const { rpc, sessionFile } = await vibeSessionWithWorker();
		await rpc.switchSession(sessionFile);
		expect((await rpc.getState()).vibeModeEnabled).toBe(true);
		expect(await rpc.setVibeMode(false)).toEqual({ enabled: false, killed: 1 });
	}, 60_000);

	test("a cancelled switch keeps vibe mode and its workers", async () => {
		// A session recorded under another working directory: RPC cancels the switch into it.
		const elsewhere = await start({ persist: true, subdirectory: "elsewhere" });
		await elsewhere.promptAndWait("hello");
		const foreignSession = (await elsewhere.getState()).sessionFile;
		if (!foreignSession) throw new Error("expected a persisted session");
		const { rpc } = await vibeSessionWithWorker();

		expect(await rpc.switchSession(foreignSession)).toEqual({ cancelled: true });
		expect((await rpc.getState()).vibeModeEnabled).toBe(true);
		expect(await rpc.setVibeMode(false)).toEqual({ enabled: false, killed: 1 });
	}, 60_000);

	test("turning vibe mode off mid-turn aborts the director's vibe_wait and kills the running worker", async () => {
		const rpc = await start({});
		const waiting = Promise.withResolvers<void>();
		rpc.onEvent(event => {
			if (event.type === "tool_execution_start" && event.toolName === "vibe_wait") waiting.resolve();
		});
		await rpc.setVibeMode(true);
		const turn = rpc.promptAndWait("spawn a slow worker").catch(() => undefined);
		await withTimeout(waiting.promise, 30_000, "the director never started vibe_wait");

		expect(await rpc.setVibeMode(false)).toEqual({ enabled: false, killed: 1 });
		// The aborted turn ends at once instead of waiting out the worker's 60 s turn.
		await withTimeout(turn, 10_000, "the director's turn kept running");
		const state = await rpc.getState();
		expect(state.isStreaming).toBe(false);
		expect(state.vibeModeEnabled).toBe(false);
		expect(await activeTools(rpc)).not.toContain("vibe_wait");
	}, 60_000);

	test("a worker running when the process exits is detached, not killed, and comes back on restart", async () => {
		let rpc = await start({ persist: true });
		await rpc.promptAndWait("hello");
		await rpc.setSubagentSubscription("progress");
		const workerStarted = Promise.withResolvers<void>();
		rpc.onSubagentLifecycle(payload => {
			if (payload.id === "Worker1" && payload.status === "started") workerStarted.resolve();
		});
		await rpc.setVibeMode(true);
		void rpc.promptAndWait("spawn a slow worker").catch(() => undefined);
		await withTimeout(workerStarted.promise, 30_000, "the worker never started");
		const sessionFile = (await rpc.getState()).sessionFile;
		if (!sessionFile) throw new Error("expected a persisted session");

		// Stops the first process while the worker's turn runs; an exit that killed the
		// workers would journal vibe mode off.
		rpc = await start({ sessionFile });
		expect((await rpc.getState()).vibeModeEnabled).toBe(true);
		expect(await rpc.setVibeMode(false)).toEqual({ enabled: false, killed: 1 });
	}, 60_000);
});
