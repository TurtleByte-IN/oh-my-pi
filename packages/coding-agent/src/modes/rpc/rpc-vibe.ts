/**
 * Vibe mode for RPC hosts (`--mode rpc` and `--mode rpc-ui`).
 *
 * The worker runtime (`VibeSessionRegistry`) and the toolset switch
 * (`AgentSession.activateVibeTools` / `deactivateVibeTools`) are shared with
 * the TUI. This controller adds what `InteractiveMode` otherwise owns for
 * `/vibe`: the toggle with its plan/goal guards, the pre-vibe tool snapshot,
 * worker suspension before a session switch, and reattach after startup or a
 * session change.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { formatModelString } from "../../config/model-resolver";
import type { AgentSession } from "../../session/agent-session";
import type { SessionManager } from "../../session/session-manager";
import { type VibeOwnerScope, type VibeParentSession, VibeSessionRegistry } from "../../vibe/runtime";
import { readPersistedToolNames } from "../../vibe/state";

export type RpcVibeSession = Pick<
	AgentSession,
	| "settings"
	| "sessionManager"
	| "asyncJobManager"
	| "getAgentId"
	| "model"
	| "isStreaming"
	| "abort"
	| "getEnabledToolNames"
	| "hasBuiltInTool"
	| "canActivateVibeTools"
	| "activateVibeTools"
	| "deactivateVibeTools"
	| "removeVibeToolsPreservingActive"
	| "getVibeModeState"
	| "setVibeModeState"
	| "sendVibeModeContext"
	| "runModeExitTeardown"
	| "getPlanModeState"
	| "getGoalModeState"
>;

/** `set_vibe_mode` result. */
export interface RpcVibeModeResult {
	/** Whether vibe mode is on after the call. */
	enabled: boolean;
	/** Worker sessions this call killed; 0 unless it exited vibe mode. */
	killed: number;
}

/** The mode the current branch last journaled, as `buildSessionContext()` reports it, without building messages. */
function journaledMode(sessionManager: Pick<SessionManager, "getBranchView">): {
	mode: string;
	data?: Record<string, unknown>;
} {
	const branch = sessionManager.getBranchView();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "mode_change") return { mode: entry.mode, data: entry.data };
	}
	return { mode: "none" };
}

export class RpcVibeController {
	readonly #session: RpcVibeSession;
	/** Enabled tool set before vibe mode replaced it; restored on exit. */
	#previousTools: string[] | undefined;
	/** Worker scope (owner agent + parent session) vibe mode was entered for. */
	#ownerScope: VibeOwnerScope | undefined;
	/** The before-switch hook already suspended {@link #ownerScope}'s workers. */
	#scopeSuspendedForSwitch = false;
	/** Toggles, switch quiesces and reconciles run one at a time. */
	#tail: Promise<unknown> = Promise.resolve();

	constructor(session: RpcVibeSession) {
		this.#session = session;
	}

	/** Whether vibe mode is on for the current session. */
	get enabled(): boolean {
		return this.#session.getVibeModeState()?.enabled === true;
	}

	/**
	 * Turn vibe mode on or off, like `/vibe`. Idempotent: asking for the current
	 * state changes nothing. Entering is refused while plan mode or goal mode
	 * (active or paused) is on, or when the session has no vibe tools (subagent
	 * sessions). Exiting aborts a running turn, kills every worker session,
	 * journals the exit and restores the pre-vibe tool set.
	 */
	set(enabled: boolean): Promise<RpcVibeModeResult> {
		return this.#serialize(async () => {
			if (!enabled) {
				const killed = await this.#exit();
				return { enabled: this.enabled, killed };
			}
			if (!this.enabled) {
				this.#assertCanEnter();
				await this.#enter({ persistModeChange: true });
			}
			return { enabled: this.enabled, killed: 0 };
		});
	}

	/**
	 * Install as the session's before-switch reconciler: detaches (does not kill)
	 * the current session's workers before `switchSession` replaces the
	 * transcript, so switching back can rehydrate them.
	 */
	quiesceForSessionSwitch(): Promise<void> {
		return this.#serialize(async () => {
			const ownerScope = this.#ownerScope;
			if (!this.enabled || !ownerScope) return;
			await VibeSessionRegistry.global().suspendScope(ownerScope, this.#session.asyncJobManager);
			this.#scopeSuspendedForSwitch = true;
		});
	}

	/**
	 * Leave the previous session's vibe mode behind and restore vibe mode journaled
	 * in the current session (startup, new/switch/branch/open), as the TUI does on
	 * resume. A change that kept the same worker scope (same session) leaves a
	 * running vibe mode untouched. Run after the goal reconcile, which may restore
	 * the previous session's pre-goal tool set.
	 */
	reconcile(): Promise<void> {
		return this.#serialize(() => this.#reconcileOnce());
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(operation);
		this.#tail = run.catch(() => undefined);
		return run;
	}

	#parentSession(): VibeParentSession {
		const session = this.#session;
		return {
			getAgentId: () => session.getAgentId() ?? null,
			getSessionId: () => session.sessionManager.getSessionId(),
			getSessionFile: () => session.sessionManager.getSessionFile() ?? null,
			sessionManager: session.sessionManager,
			asyncJobManager: session.asyncJobManager,
			settings: session.settings,
			// Restored workers resolve against this session's active model, as on the spawn path.
			getActiveModelString: () => (session.model ? formatModelString(session.model) : undefined),
		};
	}

	#assertCanEnter(): void {
		const session = this.#session;
		if (session.getPlanModeState()?.enabled) throw new Error("Exit plan mode first.");
		const goal = session.getGoalModeState();
		if (goal?.enabled || goal?.goal.status === "paused") throw new Error("Exit goal mode first.");
		if (!session.canActivateVibeTools()) {
			throw new Error("Vibe mode is unavailable in this session: only a top-level session can direct workers.");
		}
	}

	/**
	 * `previousTools`: the pre-vibe tool set to restore on exit; defaults to the
	 * current enabled set.
	 */
	async #enter(options: { persistModeChange: boolean; previousTools?: string[] }): Promise<void> {
		const session = this.#session;
		const registry = VibeSessionRegistry.global();
		const ownerScope = registry.ownerScope(this.#parentSession());
		registry.activateScope(ownerScope);
		const previousTools = options.previousTools ?? session.getEnabledToolNames();
		const baseTools = ["read"];
		if (session.hasBuiltInTool("todo")) baseTools.push("todo");
		await session.activateVibeTools(baseTools);
		this.#previousTools = previousTools;
		this.#ownerScope = ownerScope;
		session.setVibeModeState({ enabled: true });
		if (session.isStreaming) await session.sendVibeModeContext({ deliverAs: "steer" });
		if (options.persistModeChange) session.sessionManager.appendModeChange("vibe", { previousTools });
	}

	async #exit(): Promise<number> {
		if (!this.enabled) return 0;
		const session = this.#session;
		let killed = 0;
		// Queued-message drain stays suppressed so a queued steer cannot restart on
		// the vibe tools before they are removed. `killAll` journals the exit
		// (worker tombstones + `mode_change: none`) atomically.
		await session.runModeExitTeardown(async () => {
			if (session.isStreaming) await session.abort();
			killed = await VibeSessionRegistry.global().killAll(this.#parentSession(), this.#ownerScope);
			await session.deactivateVibeTools(this.#previousTools ?? []);
			session.setVibeModeState(undefined);
		});
		this.#previousTools = undefined;
		this.#ownerScope = undefined;
		return killed;
	}

	async #reconcileOnce(): Promise<void> {
		const session = this.#session;
		const scopeAlreadySuspended = this.#scopeSuspendedForSwitch;
		this.#scopeSuspendedForSwitch = false;
		const { mode, data } = journaledMode(session.sessionManager);
		const parent = this.#parentSession();
		const registry = VibeSessionRegistry.global();
		const ownerScope = this.#ownerScope;
		const targetScope = registry.ownerScope(parent);
		const wasEnabled = this.enabled;
		// Same session (a reload or no-op change): the running vibe mode and its workers stay.
		const preserve =
			wasEnabled &&
			mode === "vibe" &&
			ownerScope?.ownerId === targetScope.ownerId &&
			ownerScope.parentSessionId === targetScope.parentSessionId &&
			ownerScope.parentSessionFile === targetScope.parentSessionFile;
		if (wasEnabled && !preserve) {
			// The session change already restored the target's tools; the snapshot belongs
			// to the previous session, so only the vibe tools are stripped.
			await session.removeVibeToolsPreservingActive();
			session.setVibeModeState(undefined);
			this.#previousTools = undefined;
			this.#ownerScope = undefined;
			if (ownerScope && !scopeAlreadySuspended) await registry.suspendScope(ownerScope, session.asyncJobManager);
		}
		await registry.rehydrate(parent);
		if (mode !== "vibe" || preserve) return;
		try {
			await this.#enter({
				persistModeChange: false,
				// The live set is the previous session's reduced vibe set: use the target's own snapshot.
				previousTools: wasEnabled ? readPersistedToolNames(data?.previousTools) : undefined,
			});
		} catch (error) {
			logger.warn("RPC vibe mode could not reattach to the session", {
				sessionFile: session.sessionManager.getSessionFile(),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
