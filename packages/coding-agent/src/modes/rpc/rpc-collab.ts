/**
 * Collab hosting for RPC mode: `collab_start`, `collab_stop` and `collab_status`
 * drive a {@link CollabController} bound to the RPC session, the same controller
 * `/collab` drives in interactive mode. Every change to the room (started, guest
 * joined or left, ended by stop, session change or relay close) is reported as a
 * link-free `collab_state` frame; links travel only in command responses.
 *
 * Rooms start only on request: `collab.autoStart` does not apply to RPC sessions,
 * and a room that ends on its own is not relaunched.
 */
import type { CollabStatus } from "@oh-my-pi/pi-tui/status-line/types";
import type { CollabHostContext } from "../../collab/context";
import { CollabController } from "../../collab/controller";
import type { CollabHost } from "../../collab/host";
import type { CollabAccess } from "../../collab/registry";
import type { AgentSession } from "../../session/agent-session";
import type { EventBus } from "../../utils/event-bus";
import type { RpcCollabStateFrame, RpcCollabStatus } from "./rpc-types";

/** `collab_start` parameters. */
export interface RpcCollabStartOptions {
	access?: CollabAccess;
	relay?: string;
}

/** Owns the collab room of one RPC session. */
export class RpcCollabBridge {
	readonly #controller: CollabController;
	readonly #output: (frame: RpcCollabStateFrame) => void;
	#lastState: RpcCollabStateFrame | undefined;
	/** `collab_start` calls not yet settled; a stop that cancels one reports it stopped something. */
	#pendingStarts = 0;

	constructor(
		session: AgentSession,
		output: (frame: RpcCollabStateFrame) => void,
		options: { subagentEventBus?: EventBus } = {},
	) {
		this.#output = output;
		const ctx: CollabHostContext = {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			eventBus: undefined,
			subagentEventBus: options.subagentEventBus,
			collabHost: undefined,
			collabGuest: undefined,
			// Relay reconnects and registry warnings reach the host as session notices.
			showStatus: message => session.emitNotice("info", message, "collab"),
			// The RPC host renders its own queue from session events.
			updatePendingMessagesDisplay: () => {},
			statusLine: {
				setCollabStatus: status => this.#report(status),
				getCachedContextBreakdown: () => {
					const usage = session.getContextUsage();
					return {
						usedTokens: usage?.tokens ?? 0,
						contextWindow: usage?.contextWindow ?? session.model?.contextWindow ?? 0,
					};
				},
				invalidate: () => {},
			},
			ui: { requestRender: () => {} },
		};
		this.#controller = new CollabController(ctx, { followAutoStartSetting: false });
		// RPC startup is complete once commands are being served: guests may drive the session.
		this.#controller.startupComplete();
	}

	/** Start (or reuse) this session's room and return its links. */
	async start(options: RpcCollabStartOptions = {}): Promise<RpcCollabStatus> {
		this.#pendingStarts++;
		try {
			const host = await this.#controller.start({ access: options.access ?? "control", relay: options.relay });
			return describe(host);
		} finally {
			this.#pendingStarts--;
		}
	}

	/** End the room, cancelling any start still connecting; false when there was neither. */
	async stop(): Promise<boolean> {
		const live = this.#controller.host !== undefined || this.#pendingStarts > 0;
		await this.#controller.stop("host stopped");
		return live;
	}

	status(): RpcCollabStatus {
		const host = this.#controller.host;
		return host ? describe(host) : { active: false, participants: [] };
	}

	/** Tell guests goodbye, cancel a pending start, and stop for good (the RPC client is gone). */
	async shutdown(): Promise<void> {
		await this.#controller.shutdown("host exited");
	}

	#report(status: CollabStatus | null): void {
		const frame: RpcCollabStateFrame = {
			type: "collab_state",
			active: status !== null,
			participantCount: status?.participantCount ?? 0,
		};
		const last = this.#lastState;
		if (last && last.active === frame.active && last.participantCount === frame.participantCount) return;
		this.#lastState = frame;
		this.#output(frame);
	}
}

/** Links for the access the room was started with: a view room never hands out its write token. */
function describe(host: CollabHost): RpcCollabStatus {
	const control = host.access === "control";
	return {
		active: true,
		access: host.access,
		link: control ? host.link : host.viewLink,
		webLink: control ? host.webLink : host.webViewLink,
		relayConnected: host.relayConnected,
		participants: host.participants,
	};
}
