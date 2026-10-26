/**
 * The slice of a mode context collab hosting reads and writes.
 *
 * Interactive mode passes itself; RPC mode passes an adapter whose status line
 * and render hooks report to the RPC host instead of a terminal.
 */
import type { InteractiveModeContext } from "../modes/types";

export type CollabHostContext = Pick<
	InteractiveModeContext,
	| "session"
	| "sessionManager"
	| "settings"
	| "eventBus"
	| "subagentEventBus"
	| "collabHost"
	| "collabGuest"
	| "showStatus"
	| "updatePendingMessagesDisplay"
> & {
	statusLine: Pick<
		InteractiveModeContext["statusLine"],
		"setCollabStatus" | "getCachedContextBreakdown" | "invalidate"
	>;
	ui: Pick<InteractiveModeContext["ui"], "requestRender">;
};
