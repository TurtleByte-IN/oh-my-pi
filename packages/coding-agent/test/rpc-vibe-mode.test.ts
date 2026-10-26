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
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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
	}): Promise<RpcClient> {
		directory ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-vibe-"));
		await client?.stop();
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "vibe-rpc-agent.ts")],
			cwd: directory,
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
});
