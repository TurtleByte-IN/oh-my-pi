/**
 * RPC `revive_subagent`: a subagent this session reported, now parked or killed with
 * only its transcript on disk, is rebuilt through the persisted-subagent reviver,
 * receives the host's message as its user, and reports its revived run through the
 * same subagent frames a live run does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { handleRpcReviveSubagent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const AGENT_ID = "Reviver";
const MOCK_API_SOURCE = "test/rpc-revive-subagent";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let jobs: AsyncJobManager;
let bus: EventBus;
let frames: RpcSubagentFrame[];
let frameListener: ((frame: RpcSubagentFrame) => void) | undefined;
let registry: RpcSubagentRegistry;

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-revive-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	jobs = new AsyncJobManager({ maxRunningJobs: 4 });
	AsyncJobManager.setInstance(jobs);
	bus = new EventBus();
	frames = [];
	frameListener = undefined;
	registry = new RpcSubagentRegistry(bus, frame => {
		frames.push(frame);
		frameListener?.(frame);
	});
	registry.setSubscriptionLevel("progress");
});

afterEach(async () => {
	registry.dispose();
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	AsyncJobManager.setInstance(undefined);
	await jobs.dispose({ timeoutMs: 1_000 });
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

/** The lifecycle frames the task executor published for the original run, so this RPC session reported it. */
function reportFinishedRun(id: string, sessionFile: string): void {
	for (const status of ["started", "completed"] as const) {
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status,
			sessionFile,
			parentId: null,
			depth: 0,
		} satisfies SubagentLifecyclePayload);
	}
}

/** Resolves with the first lifecycle frame for `id` whose status is terminal. */
function nextTerminalLifecycle(id: string): Promise<SubagentLifecyclePayload> {
	const terminal = Promise.withResolvers<SubagentLifecyclePayload>();
	frameListener = frame => {
		if (frame.type === "subagent_lifecycle" && frame.payload.id === id && frame.payload.status !== "started") {
			terminal.resolve(frame.payload);
		}
	};
	return terminal.promise;
}

describe("revive_subagent over a persisted transcript", () => {
	it("rebuilds a parked subagent from disk, delivers the message, and reports the revived run", async () => {
		const cwd = path.join(root, "home", "work");
		await fs.mkdir(cwd, { recursive: true });

		// The finished subagent as a previous run left it: a transcript with its
		// session contract and its final answer, no live session.
		const main = SessionManager.create(cwd, path.join(root, "sessions"));
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		await main.close();
		const childFile = path.join(mainFile.slice(0, -".jsonl".length), `${AGENT_ID}.jsonl`);
		const child = await SessionManager.open(childFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: mainFile,
			suppressBreadcrumb: true,
		});
		child.appendSessionInit({
			systemPrompt: ["test"],
			task: "summarize the notes",
			tools: ["read"],
			agent: "task",
			resolvedModel: "mock/mock-model",
		});
		child.appendMessage({ role: "user", content: "summarize the notes", timestamp: Date.now() });
		child.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "first summary" }],
			api: "mock",
			provider: "mock",
			model: "mock-model",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await child.close();

		reportFinishedRun(AGENT_ID, childFile);
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: childFile,
			status: "parked",
		});

		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const prompts: string[] = [];
		const mock = createMockModel({
			handler: context => {
				const last = context.messages.at(-1);
				if (last?.role === "user") {
					prompts.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
				}
				return { content: ["revived summary"] };
			},
		});
		const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
		const settings = Settings.isolated({
			"task.agentIdleTtlMs": 0,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			modelRoles: { default: "mock/mock-model" },
		});
		const parent = {
			sessionManager: {
				getSessionFile: () => mainFile,
				getCwd: () => cwd,
				getArtifactManager: () => undefined,
			},
			asyncJobManager: jobs,
			settings,
			effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
			preparedExtensions: undefined,
		} as unknown as AgentSession;
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({
				session: parent,
				authStorage,
				modelRegistry,
				settings,
				enableLsp: false,
				subagentEventBus: bus,
			}),
			() => 0,
		);
		const before = frames.length;
		const revivedRunEnded = nextTerminalLifecycle(AGENT_ID);

		try {
			await expect(handleRpcReviveSubagent(registry, AGENT_ID, "now cover the appendix")).resolves.toBe(true);

			const ref = AgentRegistry.global().get(AGENT_ID);
			expect(ref?.session).not.toBeNull();
			expect(ref?.sessionFile).toBe(childFile);

			// The revived run reports through the RPC subagent frames like a live run.
			await revivedRunEnded;
			const revivedFrames = frames.slice(before);
			const revivedStatuses = revivedFrames.flatMap(frame =>
				frame.type === "subagent_lifecycle" ? [frame.payload.status] : [],
			);
			expect(revivedStatuses[0]).toBe("started");
			expect(revivedStatuses.length).toBeGreaterThanOrEqual(2);
			const started = revivedFrames.find(frame => frame.type === "subagent_lifecycle");
			expect(started?.type === "subagent_lifecycle" && started.payload.sessionFile).toBe(childFile);

			// The message went to the subagent as its user, and its transcript keeps growing in place.
			expect(prompts.join("\n")).toContain("now cover the appendix");
			const transcript = await readRpcSubagentTranscript(childFile);
			const texts = transcript.messages.map(message => JSON.stringify(message));
			expect(texts.some(text => text.includes("first summary"))).toBe(true);
			expect(texts.some(text => text.includes("now cover the appendix"))).toBe(true);
			expect(texts.some(text => text.includes("revived summary"))).toBe(true);
		} finally {
			await AgentLifecycleManager.global()
				.release(AGENT_ID)
				.catch(() => false);
			authStorage.close();
		}
	}, 20_000);
});

describe("handleRpcReviveSubagent", () => {
	let sessionDir: string;
	let ownSessionFile: string;
	let sent: string[];

	beforeEach(async () => {
		sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-revive-unit-"));
		ownSessionFile = path.join(sessionDir, "SubagentA.jsonl");
		sent = [];
	});

	afterEach(async () => {
		await removeWithRetries(sessionDir);
	});

	function liveSession(): AgentSession {
		return {
			subscribe: () => () => {},
			prompt: async (text: string) => {
				sent.push(text);
				return true;
			},
		} as unknown as AgentSession;
	}

	it("leaves a live subagent as is and still delivers the message", async () => {
		reportFinishedRun("SubagentA", ownSessionFile);
		const session = liveSession();
		AgentRegistry.global().register({
			id: "SubagentA",
			displayName: "SubagentA",
			kind: "sub",
			session,
			sessionFile: ownSessionFile,
			status: "idle",
		});

		await expect(handleRpcReviveSubagent(registry, "SubagentA", "again")).resolves.toBe(false);
		expect(sent).toEqual(["again"]);
	});

	it("revives through the lifecycle manager and reports a rebuilt session", async () => {
		reportFinishedRun("SubagentA", ownSessionFile);
		AgentRegistry.global().register({
			id: "SubagentA",
			displayName: "SubagentA",
			kind: "sub",
			session: null,
			sessionFile: ownSessionFile,
			status: "parked",
		});
		const revived = liveSession();
		const ensureLive = vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockImplementation(async id => {
			const ref = AgentRegistry.global().get(id);
			if (ref) {
				ref.session = revived;
				ref.status = "idle";
			}
			return revived;
		});

		await expect(handleRpcReviveSubagent(registry, "SubagentA")).resolves.toBe(true);
		expect(ensureLive).toHaveBeenCalledWith("SubagentA");
		expect(sent).toEqual([]);
	});

	it("refuses an id this session never reported", async () => {
		AgentRegistry.global().register({
			id: "Stranger",
			displayName: "Stranger",
			kind: "sub",
			session: null,
			sessionFile: ownSessionFile,
			status: "parked",
		});
		const ensureLive = vi.spyOn(AgentLifecycleManager.global(), "ensureLive");

		await expect(handleRpcReviveSubagent(registry, "Stranger")).rejects.toThrow("Unknown subagent: Stranger");
		expect(ensureLive).not.toHaveBeenCalled();
	});

	it("refuses another session's same-name subagent", async () => {
		reportFinishedRun("SubagentA", ownSessionFile);
		AgentRegistry.global().register({
			id: "SubagentA",
			displayName: "SubagentA",
			kind: "sub",
			session: null,
			sessionFile: path.join(sessionDir, "other-session", "SubagentA.jsonl"),
			status: "parked",
		});
		const ensureLive = vi.spyOn(AgentLifecycleManager.global(), "ensureLive");

		await expect(handleRpcReviveSubagent(registry, "SubagentA")).rejects.toThrow("Unknown subagent: SubagentA");
		expect(ensureLive).not.toHaveBeenCalled();
	});

	it("forgets subagents reported before a session change", async () => {
		reportFinishedRun("SubagentA", ownSessionFile);
		AgentRegistry.global().register({
			id: "SubagentA",
			displayName: "SubagentA",
			kind: "sub",
			session: null,
			sessionFile: ownSessionFile,
			status: "parked",
		});
		registry.clear();

		await expect(handleRpcReviveSubagent(registry, "SubagentA")).rejects.toThrow("Unknown subagent: SubagentA");
	});

	it("reports why a killed subagent cannot be revived", async () => {
		reportFinishedRun("SubagentA", ownSessionFile);
		AgentRegistry.global().register({
			id: "SubagentA",
			displayName: "SubagentA",
			kind: "sub",
			session: null,
			sessionFile: ownSessionFile,
			status: "aborted",
		});

		await expect(handleRpcReviveSubagent(registry, "SubagentA")).rejects.toThrow(
			'Agent "SubagentA" was killed and cannot be revived (no reviver registered).',
		);
	});
});
