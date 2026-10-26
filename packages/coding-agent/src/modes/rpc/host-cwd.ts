import { Snowflake } from "@oh-my-pi/pi-utils";
import type { HostCwdChange, HostCwdChangeVerdict } from "../../slash-commands/types";
import type { RpcHostCwdChangeCancelRequest, RpcHostCwdChangeRequest, RpcHostCwdChangeResult } from "./rpc-types";

type RpcHostCwdOutput = (frame: RpcHostCwdChangeRequest | RpcHostCwdChangeCancelRequest) => void;

type PendingCwdChange = {
	resolve: (frame: RpcHostCwdChangeResult) => void;
	reject: (error: Error) => void;
};

/** Type guard for inbound `host_cwd_change_result` frames coming from the host. */
export function isRpcHostCwdChangeResult(value: unknown): value is RpcHostCwdChangeResult {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown };
	return frame.type === "host_cwd_change_result" && typeof frame.id === "string";
}

/**
 * Lets the RPC host own session directory changes (`/wt`, `/move`).
 *
 * Disabled until the host sends `set_host_cwd_change {enabled: true}`; while
 * disabled the slash commands change directory on their own, as before. When
 * enabled each change becomes a `host_cwd_change_request` the command awaits.
 */
export class RpcHostCwdBridge {
	#output: RpcHostCwdOutput;
	#enabled = false;
	#pending = new Map<string, PendingCwdChange>();

	constructor(output: RpcHostCwdOutput) {
		this.#output = output;
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	/** Turn host ownership on or off; turning it off fails requests still waiting on the host. */
	setEnabled(enabled: boolean): boolean {
		this.#enabled = enabled;
		if (!enabled) this.rejectAllPending("Host stopped handling directory changes");
		return enabled;
	}

	/** Resolve a pending request by id; called by `rpc-mode` on inbound results. */
	handleResult(frame: RpcHostCwdChangeResult): boolean {
		const pending = this.#pending.get(frame.id);
		if (!pending) return false;
		this.#pending.delete(frame.id);
		pending.resolve(frame);
		return true;
	}

	rejectAllPending(message: string): void {
		const error = new Error(message);
		const pending = Array.from(this.#pending.values());
		this.#pending.clear();
		for (const entry of pending) entry.reject(error);
	}

	/**
	 * Ask the host to perform (worktree) or approve (move) a directory change.
	 * Resolves with the host's verdict; an accepted `move` without `cwd` targets
	 * the requested path. Rejects when aborted, disconnected, or the reply is malformed.
	 */
	async request(change: HostCwdChange, signal?: AbortSignal): Promise<HostCwdChangeVerdict> {
		const frame = await this.#dispatch(change, signal);
		if (frame.accepted !== true) {
			return { accepted: false, error: typeof frame.error === "string" && frame.error ? frame.error : undefined };
		}
		const cwd = typeof frame.cwd === "string" && frame.cwd ? frame.cwd : change.reason === "move" ? change.path : "";
		if (!cwd) throw new Error("Host accepted the worktree request without a directory");
		return { accepted: true, cwd };
	}

	#dispatch(change: HostCwdChange, signal: AbortSignal | undefined): Promise<RpcHostCwdChangeResult> {
		if (signal?.aborted) return Promise.reject(new Error("Directory change was aborted"));

		const id = Snowflake.next() as string;
		const { promise, resolve, reject } = Promise.withResolvers<RpcHostCwdChangeResult>();
		let settled = false;
		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			this.#output({ type: "host_cwd_change_cancel", id: Snowflake.next() as string, targetId: id });
			reject(new Error("Directory change was aborted"));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pending.set(id, {
			resolve: frame => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(frame);
			},
			reject: err => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(err);
			},
		});

		this.#output(
			change.reason === "move"
				? { type: "host_cwd_change_request", id, reason: "move", cwd: change.cwd, path: change.path }
				: { type: "host_cwd_change_request", id, reason: "worktree", cwd: change.cwd, branch: change.branch },
		);
		return promise;
	}
}
