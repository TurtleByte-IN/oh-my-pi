/**
 * Wire definitions for non-command frames: unsolicited server notifications,
 * the extension UI sub-protocol, and the host tool/URI sub-protocols.
 */
import { absentAs, doc, type WireDefs } from "./dsl";

const JSON_OBJECT = "Record<string, unknown>";
const UI = "'extension_ui_request'";
/**
 * Spawn-tree fields carried by every subagent frame and `get_subagents` snapshot.
 * Older servers omit them; decoders read that as a root-spawned subagent.
 */
export const SUBAGENT_LINEAGE = {
	parentId: absentAs(
		doc("string | null", "Id of the subagent that spawned this one; null when the root session spawned it."),
		null,
	),
	depth: absentAs(
		doc(
			"number.integer",
			"Subagent ancestors above this one: 0 when the root session spawned it, 1 for its children, and so on.",
		),
		0,
	),
} as const;

/** `parentToolCallId` on subagent frames and `get_subagents` snapshots. */
export const PARENT_TOOL_CALL_ID = doc(
	"string",
	"Tool call that spawned the subagent: the `task` call, or for a vibe worker the `vibe_spawn` call, on every turn.",
);

export const frameDefs = {
	ReadyEvent: doc(
		{
			type: "'ready'",
			"protocolVersion?": "number.integer",
			"supportedProtocolVersions?": "number.integer[]",
			"maxFrameBytes?": "number.integer",
			"maxReassembledFrameBytes?": "number.integer",
			"contractVersion?": doc(
				"string",
				"Semver of the RPC contract (the wire shape); absent on servers before contract versions.",
			),
		},
		"First frame after startup; transport fields are absent on servers without protocol v2.",
	),
	PromptStatus: "'completed' | 'aborted' | 'error'",
	PromptError: doc(
		{
			message: "string",
			"provider?": "string",
			"model?": "string",
			"httpStatus?": "number.integer",
			retryable: doc("boolean", "Transient: resubmitting later may succeed (omp's own retries are exhausted)."),
		},
		'Failure detail of a `prompt_result` with `status: "error"`.',
	),
	PromptResultEvent: doc(
		{
			type: "'prompt_result'",
			"id?": "string",
			agentInvoked: "boolean",
			status: "PromptStatus",
			"error?": "PromptError",
			sessionSettled: doc(
				"boolean",
				"Nothing will wake the session again; when false a `session_settled` follows once background work drains.",
			),
		},
		"Terminal outcome of one accepted `prompt` / `abort_and_prompt`, keyed by request `id`.",
	),
	SessionSettledEvent: doc(
		{ type: "'session_settled'" },
		"The session went quiet: the last run yielded and no background work can wake it.",
	),
	ExtensionError: { type: "'extension_error'", extensionPath: "string", event: "string", error: "string" },
	AvailableCommandsUpdateEvent: doc(
		{ type: "'available_commands_update'", commands: "AvailableSlashCommand[]" },
		"Slash-command catalog, pushed at startup and whenever command metadata changes.",
	),
	SubagentLifecycleStatus: "'started' | 'completed' | 'failed' | 'aborted'",
	SubagentLifecyclePayload: {
		id: "string",
		agent: "string",
		agentSource: "AgentSource",
		"description?": "string",
		status: "SubagentLifecycleStatus",
		"sessionFile?": "string",
		"parentToolCallId?": PARENT_TOOL_CALL_ID,
		...SUBAGENT_LINEAGE,
		index: "number.integer",
		"detached?": doc("boolean", "The subagent runs as a detached background job."),
	},
	SubagentProgressPayload: {
		index: "number.integer",
		agent: "string",
		agentSource: "AgentSource",
		task: "string",
		"parentToolCallId?": PARENT_TOOL_CALL_ID,
		...SUBAGENT_LINEAGE,
		"assignment?": "string",
		progress: doc(JSON_OBJECT, "Raw `AgentProgress` record."),
		"sessionFile?": "string",
		"detached?": "boolean",
	},
	SubagentEventPayload: { id: "string", ...SUBAGENT_LINEAGE, event: "RpcAgentEvent" },
	SubagentLifecycleEvent: doc(
		{ type: "'subagent_lifecycle'", payload: "SubagentLifecyclePayload" },
		'A subagent started or ended; sent at subscription level "progress" or "events".',
	),
	SubagentProgressEvent: doc(
		{ type: "'subagent_progress'", payload: "SubagentProgressPayload" },
		'Aggregated subagent progress; sent at subscription level "progress" or "events".',
	),
	SubagentEvent: doc(
		{ type: "'subagent_event'", payload: "SubagentEventPayload" },
		'A subagent\'s own session event; sent only at subscription level "events".',
	),
	LivePhase: "'connecting' | 'listening' | 'working' | 'speaking' | 'muted' | 'error'",
	LiveRole: "'user' | 'assistant'",
	LivePhaseEvent: { type: "'live_phase'", phase: "LivePhase" },
	LiveLevelsEvent: doc(
		{ type: "'live_levels'", input: "number", output: "number" },
		"Microphone (`input`) and speaker (`output`) RMS in [0, 1], at most every 100 ms.",
	),
	LiveTranscriptEvent: doc(
		{ type: "'live_transcript'", role: "LiveRole", turn: "number.integer", text: "string", final: "boolean" },
		"Accumulated text of one realtime turn; replaces earlier frames with the same `role` and `turn`.",
	),
	LiveEndEvent: doc(
		{ type: "'live_end'", "error?": "string" },
		"Sent exactly once when a live session ends; `error` carries the failure cause.",
	),
	CollabAccess: doc(
		"'view' | 'control'",
		"What a collab link grants: `view` watches the session; `control` also lets guests prompt and interrupt it. Over RPC guests never see dialogs; they go to the RPC host.",
	),
	CollabParticipant: {
		name: "string",
		role: "'host' | 'guest'",
		"readOnly?": doc("boolean", "True for a guest that joined through a view link."),
	},
	CollabStatus: doc(
		{
			active: "boolean",
			"access?": "CollabAccess",
			"link?": doc("string", "`omp join` link for the granted access; a capability, never logged."),
			"webLink?": doc("string", "Browser link for the granted access; a capability, never logged."),
			"relayConnected?": "boolean",
			participants: doc("CollabParticipant[]", "Host first; empty when no room is active."),
		},
		"This session's collab room. Links are present only while `active`; anyone holding one reaches the session through the relay, outside any access control of the RPC host.",
	),
	CollabStateEvent: doc(
		{ type: "'collab_state'", active: "boolean", participantCount: "number.integer" },
		"The collab room started, gained or lost a guest, or ended (stop, session change, relay close). Carries no links; call `collab_status` for them.",
	),
	BtwDeltaEvent: doc(
		{ type: "'btw_delta'", recordId: "string", delta: "string" },
		"Text appended to the running side question's latest answer.",
	),
	BtwRecordEvent: doc(
		{ type: "'btw_record'", record: "BtwHistoryRecord" },
		"Full side-question record on every lifecycle change (started, complete, cancelled, error); the last one per id wins.",
	),
	CommandOutputEvent: doc({ type: "'command_output'", text: "string" }, "Output of a builtin slash command."),
	SessionInfoUpdateEvent: doc(
		{ type: "'session_info_update'", "title?": "string", sessionId: "string" },
		"A builtin slash command changed the session title.",
	),
	ConfigUpdateEvent: doc(
		{ type: "'config_update'", "model?": "ModelInfo", "thinkingLevel?": "ThinkingLevel" },
		"A builtin slash command changed the model configuration.",
	),
	RpcFrameErrorEvent: doc(
		{ type: "'rpc_frame_error'", "originalType?": "string", error: "string" },
		"An event could not fit within the transport limits and was dropped.",
	),

	WidgetPlacement: "'aboveEditor' | 'belowEditor'",
	SelectOptionDetail: doc({ "description?": "string" }, "Presentation metadata aligned positionally with `options`."),
	AskOption: { label: "string", "description?": "string", "preview?": "string" },
	AskQuestion: doc(
		{
			id: "string",
			question: "string",
			"header?": "string",
			options: "AskOption[]",
			multi: absentAs("boolean", false),
			"recommended?": doc("number.integer", "Index into `options` of the recommended choice."),
		},
		"One question of an `ask` request; hosts always offer free text besides `options`.",
	),
	SelectUiRequest: {
		type: UI,
		id: "string",
		method: "'select'",
		title: "string",
		options: "string[]",
		"optionDetails?": "SelectOptionDetail[]",
		"timeout?": "number.integer",
	},
	ConfirmUiRequest: {
		type: UI,
		id: "string",
		method: "'confirm'",
		title: "string",
		message: "string",
		"timeout?": "number.integer",
	},
	InputUiRequest: {
		type: UI,
		id: "string",
		method: "'input'",
		title: "string",
		"placeholder?": "string",
		"timeout?": "number.integer",
		"secret?": doc(
			"boolean",
			"Mask the answer and keep it out of history and logs; sent only for a `login` that passed `secretInput: true`.",
		),
	},
	EditorUiRequest: {
		type: UI,
		id: "string",
		method: "'editor'",
		title: "string",
		"prefill?": "string",
		"promptStyle?": "boolean",
	},
	AskUiRequest: doc(
		{ type: UI, id: "string", method: "'ask'", questions: "AskQuestion[]", "timeout?": "number.integer" },
		"Every question of one `ask` tool call; sent only after `set_ask_dialog` enables it.",
	),
	CancelUiRequest: doc(
		{ type: UI, id: "string", method: "'cancel'", targetId: "string" },
		"Close the dialog opened by request `targetId`; a later answer to it is ignored.",
	),
	NotifyUiRequest: {
		type: UI,
		id: "string",
		method: "'notify'",
		message: "string",
		"notifyType?": "NotifyType",
	},
	SetStatusUiRequest: {
		type: UI,
		id: "string",
		method: "'setStatus'",
		statusKey: "string",
		"statusText?": "string",
	},
	SetWidgetUiRequest: {
		type: UI,
		id: "string",
		method: "'setWidget'",
		widgetKey: "string",
		"widgetLines?": "string[]",
		"widgetPlacement?": "WidgetPlacement",
	},
	SetTitleUiRequest: { type: UI, id: "string", method: "'setTitle'", title: "string" },
	SetEditorTextUiRequest: { type: UI, id: "string", method: "'set_editor_text'", text: "string" },
	OpenUrlUiRequest: {
		type: UI,
		id: "string",
		method: "'open_url'",
		url: "string",
		"launchUrl?": doc("string", "Short loopback redirect to `url`; the truncation-safe copy target."),
		"instructions?": "string",
	},
	ExtensionUiRequest: doc(
		"SelectUiRequest | ConfirmUiRequest | InputUiRequest | EditorUiRequest | AskUiRequest | CancelUiRequest | NotifyUiRequest | SetStatusUiRequest | SetWidgetUiRequest | SetTitleUiRequest | SetEditorTextUiRequest | OpenUrlUiRequest",
		"Extension UI request, discriminated by `method`.",
	),
	AskAnswer: doc(
		{ id: "string", selectedOptions: "string[]", "customInput?": "string" },
		"Answer to one `ask` question: exact option labels, plus optional free text.",
	),
	ValueUiResponse: doc(
		{ type: "'extension_ui_response'", id: "string", value: "string" },
		"Answers a `select`, `input`, or `editor` request.",
	),
	ConfirmUiResponse: doc(
		{ type: "'extension_ui_response'", id: "string", confirmed: "boolean" },
		"Answers a `confirm` request.",
	),
	CancelUiResponse: doc(
		{ type: "'extension_ui_response'", id: "string", cancelled: "true", "timedOut?": "boolean" },
		"Dismisses a dialog; `timedOut` reports the host's own deadline (an `ask` then takes its recommended answers).",
	),
	AnswersUiResponse: doc(
		{ type: "'extension_ui_response'", id: "string", answers: "AskAnswer[]" },
		"Answers an `ask` request: one `AskAnswer` per question, in question order.",
	),
	ExtensionUiResponse: doc(
		"ValueUiResponse | ConfirmUiResponse | CancelUiResponse | AnswersUiResponse",
		"Host reply to an extension UI request; variants share `type` and differ by their payload key.",
	),

	HostToolCallRequest: {
		type: "'host_tool_call'",
		id: "string",
		toolCallId: "string",
		toolName: "string",
		arguments: JSON_OBJECT,
	},
	HostToolCancelRequest: { type: "'host_tool_cancel'", id: "string", targetId: "string" },
	HostToolResultPayload: doc(
		{
			content: "UserContent[]",
			"details?": "unknown",
			"isError?": "boolean",
			"useless?": "boolean",
			"providerMetadata?": JSON_OBJECT,
		},
		"Tool output: content blocks plus optional details.",
	),
	HostToolUpdate: doc(
		{ type: "'host_tool_update'", id: "string", partialResult: "HostToolResultPayload" },
		"Streams partial output of a pending host tool call.",
	),
	HostToolResult: doc(
		{ type: "'host_tool_result'", id: "string", result: "HostToolResultPayload", "isError?": "boolean" },
		"Completes a pending host tool call; `isError` surfaces the content as a tool error.",
	),
	HostUriOperation: "'read' | 'write'",
	HostUriRequest: {
		type: "'host_uri_request'",
		id: "string",
		operation: "HostUriOperation",
		url: "string",
		"content?": doc("string", "Present for write operations."),
	},
	HostUriCancelRequest: { type: "'host_uri_cancel'", id: "string", targetId: "string" },
	HostUriResult: doc(
		{
			type: "'host_uri_result'",
			id: "string",
			"content?": doc("string", "Required for a successful read."),
			"contentType?": "'text/markdown' | 'application/json' | 'text/plain'",
			"notes?": "string[]",
			"immutable?": "boolean",
			"isError?": "boolean",
			"error?": "string",
		},
		"Completes a pending host URI request.",
	),
	HostCwdChangeReason: doc(
		"'worktree' | 'move'",
		"Which command wants to change the session directory: `/wt` (`worktree`) or `/move` (`move`).",
	),
	HostCwdChangeRequest: doc(
		{
			type: "'host_cwd_change_request'",
			id: "string",
			reason: "HostCwdChangeReason",
			cwd: doc("string", "The session's current working directory."),
			"path?": doc("string", "`move` only: the resolved, existing target directory."),
			"branch?": doc("string", "`worktree` only: the branch the user asked for, or a generated default."),
		},
		"Asks the host to own a session directory change; sent only after `set_host_cwd_change` enabled it. For `worktree` the host creates the worktree; for `move` it approves the target.",
	),
	HostCwdChangeCancelRequest: doc(
		{ type: "'host_cwd_change_cancel'", id: "string", targetId: "string" },
		"The command waiting on `targetId` was aborted; the server ignores any later result for it.",
	),
	HostCwdChangeResult: doc(
		{
			type: "'host_cwd_change_result'",
			id: "string",
			accepted: "boolean",
			"cwd?": doc(
				"string",
				"Absolute existing directory to move the session into. Required to accept `worktree`; defaults to the request `path` for `move`.",
			),
			"error?": doc("string", "Reason shown to the user when `accepted` is false."),
		},
		"Host reply to a `host_cwd_change_request`: on accept the server moves the session into `cwd`; on reject it stays put.",
	),
	RpcHostRequest: doc(
		"HostToolCallRequest | HostToolCancelRequest | HostUriRequest | HostUriCancelRequest | HostCwdChangeRequest | HostCwdChangeCancelRequest",
		"Server request for host-owned tools, URI schemes, and directory changes, discriminated by `type`.",
	),
	RpcInbound: doc(
		"ExtensionUiResponse | HostToolUpdate | HostToolResult | HostUriResult | HostCwdChangeResult",
		"Non-command frame the host sends, discriminated by `type`.",
	),
	RpcResponse: doc(
		{
			type: "'response'",
			"id?": doc("string", "The command's `id`; absent for failures the server could not correlate."),
			command: "string",
			success: "boolean",
			"data?": doc("unknown", "Command result on success; its shape is the command's `result`."),
			"error?": doc("string", "Failure message when `success` is false."),
			"code?": doc("string", "Machine-readable failure reason, when one applies."),
		},
		"Response to a command, correlated by `id`.",
	),
	ToolLoadMode: "'essential' | 'discoverable'",
	HostToolDefinition: {
		name: "string",
		"label?": "string",
		description: "string",
		parameters: JSON_OBJECT,
		"hidden?": "boolean",
		"loadMode?": "ToolLoadMode",
		"readsSkillUris?": "boolean",
	},
	HostUriSchemeDefinition: {
		scheme: "string",
		"description?": "string",
		"writable?": "boolean",
		"immutable?": "boolean",
	},
} satisfies WireDefs;
