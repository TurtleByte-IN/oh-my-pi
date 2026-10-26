/**
 * RPC contract version: a semver for the wire shape the `wire` schema describes.
 *
 * `ready` and the `negotiate_protocol` response report `RPC_CONTRACT_VERSION`
 * next to `protocolVersion` (which only selects framing). Hosts pin the
 * version through the generated `packages/rpc-contract` package.
 *
 * `contract-history.json` records each released version with the shape hash
 * of the schema bundle at that version (`scripts/gen-rpc/contract.ts` computes
 * it; documentation text and ordering are excluded). It is JSON so the
 * append-only check can read the base branch's copy with `git show`.
 * `test/rpc-wire/contract.test.ts` fails when the current bundle's hash differs
 * from the last entry, or when an entry recorded on the base branch was edited
 * or removed. See `docs/rpc-contract.md`.
 */
import history from "./contract-history.json" with { type: "json" };

/** One released contract version and the shape hash of its schema bundle. */
export interface RpcContractRelease {
	version: string;
	schemaHash: string;
}

export const RPC_CONTRACT_HISTORY: readonly RpcContractRelease[] = history;

/** Contract version this build speaks: the last `RPC_CONTRACT_HISTORY` entry. */
export const RPC_CONTRACT_VERSION: string = RPC_CONTRACT_HISTORY[RPC_CONTRACT_HISTORY.length - 1].version;
