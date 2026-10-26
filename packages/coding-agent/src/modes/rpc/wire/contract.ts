/**
 * RPC contract version: a semver for the wire shape the `wire` schema describes.
 *
 * `ready` and the `negotiate_protocol` response report `RPC_CONTRACT_VERSION`
 * next to `protocolVersion` (which only selects framing). Hosts pin the
 * version through the generated `packages/rpc-contract` package.
 *
 * Each entry records the shape hash of the schema bundle at that version
 * (`scripts/gen-rpc/contract.ts` computes it; documentation text is excluded).
 * `test/rpc-wire/contract.test.ts` fails when the current bundle's hash differs
 * from the last entry, so a frame shape cannot change without a new entry.
 * The list is append-only: never edit a recorded entry. See `docs/rpc-contract.md`.
 */

/** One released contract version and the shape hash of its schema bundle. */
export interface RpcContractRelease {
	version: string;
	schemaHash: string;
}

export const RPC_CONTRACT_HISTORY: readonly RpcContractRelease[] = [
	{ version: "1.0.0", schemaHash: "sha256:ad9e27bb7f834394aa8e8d6d42bcc59f5b8903782b8cf455e11a59fa9e23aec1" },
];

/** Contract version this build speaks: the last `RPC_CONTRACT_HISTORY` entry. */
export const RPC_CONTRACT_VERSION: string = RPC_CONTRACT_HISTORY[RPC_CONTRACT_HISTORY.length - 1].version;
