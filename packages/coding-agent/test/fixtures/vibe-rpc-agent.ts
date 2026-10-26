import * as path from "node:path";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

// Real SDK session (vibe tools registered as in production), RPC dispatch and vibe worker
// runtime; only the model is scripted. One mock model serves the director and its workers.
// Director: a prompt containing "spawn a worker" calls `vibe_spawn` (tool call id `spawn-call`)
// for worker `Worker1`; "message the worker" calls `vibe_send` on it; anything else gets text.
// Workers (the sessions offered `yield`) yield a result.
// VIBE_RPC_PLAN="1": the session starts in plan mode.
// VIBE_RPC_SUBAGENT="1": the session is built as a subagent (task depth 1), so it has no vibe tools.
// VIBE_RPC_PERSIST="1": a file-backed session under <cwd>/sessions.
// VIBE_RPC_SESSION_FILE=<path>: start on that session file.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("mock", "test-key");
authStorage.keys.setRuntime("anthropic", "test-key");
registerMockApi("test/vibe-rpc-agent");

function lastUserText(context: Context): string {
	const last = context.messages.at(-1);
	if (last?.role !== "user") return "";
	if (typeof last.content === "string") return last.content;
	return last.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

function reply(context: Context): MockResponse {
	const tools = new Set((context.tools ?? []).map(tool => tool.name));
	const lastRole = context.messages.at(-1)?.role;
	if (tools.has("yield")) {
		if (lastRole === "toolResult") return { content: ["done"] };
		return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "worker done" } }] };
	}
	if (lastRole === "toolResult") return { content: ["ok"] };
	const text = lastUserText(context);
	if (text.includes("spawn a worker") && tools.has("vibe_spawn")) {
		return {
			content: [
				{
					type: "toolCall",
					id: "spawn-call",
					name: "vibe_spawn",
					arguments: { cli: "fast", name: "Worker1", prompt: "count the files" },
				},
			],
		};
	}
	if (text.includes("message the worker") && tools.has("vibe_send")) {
		return {
			content: [
				{
					type: "toolCall",
					id: "send-call",
					name: "vibe_send",
					arguments: { session: "Worker1", message: "count them again" },
				},
			],
		};
	}
	return { content: ["pong"] };
}

const model = createMockModel({ handler: reply });
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const find = modelRegistry.find.bind(modelRegistry);
modelRegistry.find = (provider, id) => (provider === model.provider && id === model.id ? model : find(provider, id));
modelRegistry.getAvailable = () => [model];
const settings = await Settings.init({
	inMemory: true,
	cwd,
	overrides: {
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"autolearn.enabled": false,
		"task.completionProbe": false,
		modelRoles: { default: "mock/mock-model", smol: "mock/mock-model", task: "mock/mock-model" },
	},
});
const sessionFile = Bun.env.VIBE_RPC_SESSION_FILE;
const sessionManager = sessionFile
	? await SessionManager.open(sessionFile)
	: Bun.env.VIBE_RPC_PERSIST === "1"
		? SessionManager.create(cwd, path.join(cwd, "sessions"))
		: SessionManager.inMemory(cwd);
const subagentEventBus = new EventBus();
// The director runs on a bundled model whose turns the mock answers (a mock model in
// `get_state` would serialize its recorded calls); workers resolve the mock through the registry.
const { session } = await createAgentSession({
	cwd,
	agentDir: cwd,
	sessionManager,
	authStorage,
	modelRegistry,
	settings,
	model: getBundledModel("anthropic", "claude-sonnet-4-5"),
	subagentEventBus,
	taskDepth: Bun.env.VIBE_RPC_SUBAGENT === "1" ? 1 : undefined,
	disableExtensionDiscovery: true,
	skills: [],
	contextFiles: [],
	workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
});
session.agent.streamFn = model.stream;
if (Bun.env.VIBE_RPC_PLAN === "1") {
	session.setPlanModeState({ enabled: true, planFilePath: path.join(cwd, "plan.md") });
}
await runRpcMode(session, { subagentEventBus });
