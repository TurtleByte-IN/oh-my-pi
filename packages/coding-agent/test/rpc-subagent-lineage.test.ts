import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame, RpcSubagentSnapshot } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { resolveSubagentLineage, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SubagentLineage } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "./helpers/session-defaults";

/**
 * O-3: every subagent frame the RPC surface writes (`subagent_lifecycle`,
 * `subagent_progress`, `subagent_event`, including the subagent's own tool
 * events) carries `parentId` and `depth`. A subagent the root session spawned
 * has `{ parentId: null, depth: 0 }`; each nested level adds one and names its
 * spawner.
 */

const agent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const ALPHA = "Alpha";
const BETA = "Alpha.Beta";
const GAMMA = "Alpha.Beta.Gamma";
const CHILD_OF: Record<string, string | undefined> = { [ALPHA]: BETA, [BETA]: GAMMA };
const EXPECTED: Record<string, SubagentLineage> = {
	[ALPHA]: { parentId: null, depth: 0 },
	[BETA]: { parentId: ALPHA, depth: 1 },
	[GAMMA]: { parentId: BETA, depth: 2 },
};

function frameSubagentId(frame: RpcSubagentFrame): string {
	return frame.type === "subagent_progress" ? frame.payload.progress.id : frame.payload.id;
}

describe("RPC subagent lineage", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir = TempDir.createSync("@pi-subagent-lineage-");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AsyncJobManager.resetForTests();
		tempDir[Symbol.dispose]();
	});

	function spawnOptions(id: string, treeBus: EventBus, taskDepth: number, parentAgentId: string) {
		return {
			cwd: "/tmp",
			agent,
			task: `work as ${id}`,
			index: 0,
			id,
			structured: false,
			taskDepth,
			parentAgentId,
			settings: Settings.isolated({}),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: tempDir.path(),
			eventBus: new EventBus(),
			subagentEventBus: treeBus,
		};
	}

	it("stamps parentId and depth on lifecycle, progress, event and tool-event frames three levels deep", async () => {
		const treeBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		// The RPC server writes each frame as one JSON line; round-trip so `null` survives as on the wire.
		const rpcRegistry = new RpcSubagentRegistry(treeBus, frame => frames.push(JSON.parse(JSON.stringify(frame))));
		rpcRegistry.setSubscriptionLevel("events");
		let rosterWhileNested: RpcSubagentSnapshot[] = [];

		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options: CreateAgentSessionOptions = {}) => {
			const id = options.agentId ?? "";
			const listeners: Array<(event: AgentSessionEvent) => void> = [];
			const messages: unknown[] = [];
			const emit = (event: AgentSessionEvent) => {
				for (const listener of listeners.slice()) listener(event);
			};
			let prompted = false;
			const session: Partial<AgentSession> = {
				...createSessionDefaults(),
				state: { messages: [] } as never,
				agent: { state: { systemPrompt: ["test"] } } as never,
				model: { api: "anthropic-messages" } as never,
				extensionRunner: undefined as never,
				sessionManager: { appendSessionInit: () => {} } as never,
				getActiveToolNames: () => ["read", "task"],
				getEnabledToolNames: () => ["read", "task"],
				subscribe: listener => {
					listeners.push(listener);
					return () => {
						const index = listeners.indexOf(listener);
						if (index >= 0) listeners.splice(index, 1);
					};
				},
				prompt: async () => {
					if (prompted) return true;
					prompted = true;
					emit({ type: "agent_start" } as AgentSessionEvent);
					// A tool call of the subagent's own, forwarded as `subagent_event`.
					const toolCallId = `read-${id}`;
					emit({
						type: "tool_execution_start",
						toolCallId,
						toolName: "read",
						args: { path: "x" },
					} as AgentSessionEvent);
					emit({
						type: "tool_execution_end",
						toolCallId,
						toolName: "read",
						result: { content: [{ type: "text", text: "ok" }] },
						isError: false,
					} as AgentSessionEvent);
					const childId = CHILD_OF[id];
					if (childId) {
						// What the `task` tool does inside a subagent: spawn at the session's own
						// task depth with its own agent id, on the tree's shared observability bus.
						await runSubprocess(
							spawnOptions(childId, options.subagentEventBus ?? treeBus, options.taskDepth ?? 0, id),
						);
					} else {
						rosterWhileNested = rpcRegistry.getSubagents();
					}
					const message = {
						role: "assistant",
						content: [{ type: "text", text: `${id} done` }],
						stopReason: "stop",
					};
					messages.push(message);
					emit({ type: "message_end", message } as unknown as AgentSessionEvent);
					emit({ type: "agent_end", messages: [message] } as unknown as AgentSessionEvent);
					return true;
				},
				getLastAssistantMessage: () => messages.at(-1) as never,
				abort: async () => {},
				dispose: async () => {},
			};
			AgentRegistry.global().register({
				id,
				displayName: id,
				kind: "sub",
				parentId: options.parentAgentId,
				session: session as AgentSession,
				sessionFile: null,
				status: "running",
			});
			return {
				session: session as AgentSession,
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies CreateAgentSessionResult;
		});

		await runSubprocess(spawnOptions(ALPHA, treeBus, 0, MAIN_AGENT_ID));
		rpcRegistry.dispose();

		for (const id of [ALPHA, BETA, GAMMA]) {
			const own = frames.filter(frame => frameSubagentId(frame) === id);
			const lifecycle = own.flatMap(frame => (frame.type === "subagent_lifecycle" ? [frame.payload.status] : []));
			const toolEvents = own.flatMap(frame =>
				frame.type === "subagent_event" && frame.payload.event.type.startsWith("tool_execution_")
					? [frame.payload.event.type]
					: [],
			);
			expect(lifecycle).toEqual(["started", "completed"]);
			expect(own.some(frame => frame.type === "subagent_progress")).toBe(true);
			expect(toolEvents).toEqual(["tool_execution_start", "tool_execution_end"]);
			for (const frame of own) {
				expect({ type: frame.type, parentId: frame.payload.parentId, depth: frame.payload.depth }).toEqual({
					type: frame.type,
					...EXPECTED[id],
				});
			}
		}
		expect(frames.every(frame => EXPECTED[frameSubagentId(frame)] !== undefined)).toBe(true);
		// `get_subagents` reports the same tree while the deepest level runs.
		expect(rosterWhileNested.map(({ id, parentId, depth }) => ({ id, parentId, depth }))).toEqual([
			{ id: ALPHA, ...EXPECTED[ALPHA] },
			{ id: BETA, ...EXPECTED[BETA] },
			{ id: GAMMA, ...EXPECTED[GAMMA] },
		]);
	});

	it("resolves the lineage of a registered subagent from its parent chain", () => {
		const registry = AgentRegistry.global();
		const register = (id: string, parentId?: string) =>
			registry.register({ id, displayName: id, kind: "sub", parentId, session: null, status: "parked" });
		register(ALPHA, MAIN_AGENT_ID);
		register(BETA, ALPHA);
		register(GAMMA, BETA);

		expect(resolveSubagentLineage(ALPHA)).toEqual(EXPECTED[ALPHA]);
		expect(resolveSubagentLineage(BETA)).toEqual(EXPECTED[BETA]);
		expect(resolveSubagentLineage(GAMMA)).toEqual(EXPECTED[GAMMA]);
		expect(resolveSubagentLineage("Unknown")).toEqual({ parentId: null, depth: 0 });
	});
});
