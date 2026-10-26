/**
 * RPC contract identity: the shape hash of the wire schema bundle, the
 * append-only rule for the version history, and the generated files of
 * `packages/rpc-contract` that carry the version.
 *
 * The shape hash covers everything a decoder or encoder depends on and ignores
 * documentation text and authoring order, so rewording a doc comment, moving a
 * definition or field, or reordering a `required`/`enum`/`clientOmit` list does
 * not demand a contract version bump while any change to a command, frame,
 * field, type, enum value, default, or decoder marker does. Union member order
 * (`anyOf`) counts.
 */
import type { RpcWireBundle } from "../../src/modes/rpc/wire";
import { RPC_CONTRACT_HISTORY, type RpcContractRelease } from "../../src/modes/rpc/wire/contract";

/** Repository path of the version history, for messages and the base-branch lookup. */
export const RPC_CONTRACT_HISTORY_PATH = "packages/coding-agent/src/modes/rpc/wire/contract-history.json";

/** Schema keywords whose value maps names to subschemas (the names themselves are shape). */
const SCHEMA_MAPS: Record<string, true> = {
	properties: true,
	$defs: true,
	patternProperties: true,
	dependentSchemas: true,
};
/** Schema keywords whose value is instance data, kept verbatim apart from key order. */
const DATA_KEYWORDS: Record<string, true> = { const: true, default: true, examples: true };
/** Schema keywords whose value is an unordered set of scalars: sorted before hashing. */
const SET_KEYWORDS: Record<string, true> = { required: true, enum: true };
/** Documentation-only schema keywords. */
const DOC_KEYWORDS: Record<string, true> = { description: true, title: true, $comment: true };

function compareJson(a: unknown, b: unknown): number {
	const left = JSON.stringify(a);
	const right = JSON.stringify(b);
	return left < right ? -1 : left > right ? 1 : 0;
}

export function sortedData(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortedData);
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(record)
			.sort()
			.map(key => [key, sortedData(record[key])]),
	);
}

function sortedSet(value: unknown): unknown {
	return Array.isArray(value) ? value.map(sortedData).sort(compareJson) : sortedData(value);
}

export function schemaMap(map: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.keys(map)
			.sort()
			.map(name => [name, schemaShape(map[name])]),
	);
}

function schemaShape(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(schemaShape);
	if (node === null || typeof node !== "object") return node;
	const record = node as Record<string, unknown>;
	const shape: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		if (DOC_KEYWORDS[key]) continue;
		const value = record[key];
		if (SET_KEYWORDS[key]) {
			shape[key] = sortedSet(value);
		} else if (DATA_KEYWORDS[key]) {
			shape[key] = sortedData(value);
		} else if (SCHEMA_MAPS[key] && value !== null && typeof value === "object") {
			shape[key] = schemaMap(value as Record<string, unknown>);
		} else {
			shape[key] = schemaShape(value);
		}
	}
	return shape;
}

/**
 * The bundle reduced to its wire shape: documentation (`description`, `title`,
 * `$comment`, command `doc`) dropped; object keys, commands, and the
 * `required`, `enum`, and `clientOmit` sets sorted.
 */
export function rpcContractShape(bundle: RpcWireBundle): unknown {
	const { commands, ...unions } = bundle["x-rpc"];
	return {
		$schema: bundle.$schema,
		$id: bundle.$id,
		"x-rpc": {
			...(sortedData(unions) as Record<string, unknown>),
			commands: commands
				.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
				.map(({ doc: _doc, clientOmit, ...command }) => ({
					...(sortedData(command) as Record<string, unknown>),
					clientOmit: sortedSet(clientOmit),
				})),
		},
		$defs: schemaMap(bundle.$defs),
	};
}

/** `sha256:<hex>` of the canonical JSON of `rpcContractShape(bundle)`. */
export function rpcContractSchemaHash(bundle: RpcWireBundle): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(JSON.stringify(rpcContractShape(bundle)));
	return `sha256:${hasher.digest("hex")}`;
}

/** The release this build reports: the last entry of `RPC_CONTRACT_HISTORY`. */
export function currentRpcContractRelease(): RpcContractRelease {
	return RPC_CONTRACT_HISTORY[RPC_CONTRACT_HISTORY.length - 1];
}

/**
 * Message for a bundle whose shape no longer matches the recorded release, or
 * `null` when it does.
 */
export function rpcContractDrift(bundle: RpcWireBundle): string | null {
	const release = currentRpcContractRelease();
	const schemaHash = rpcContractSchemaHash(bundle);
	if (schemaHash === release.schemaHash) return null;
	return [
		`The RPC wire shape changed but RPC contract ${release.version} records ${release.schemaHash}.`,
		`Append a new release to ${RPC_CONTRACT_HISTORY_PATH}`,
		`(semver: major for a breaking change, minor for an addition; see docs/rpc-contract.md):`,
		`\t{ "version": "<next>", "schemaHash": "${schemaHash}" }`,
		`then set the same version in packages/rpc-contract/package.json and rerun \`bun run gen:rpc\`.`,
	].join("\n");
}

/**
 * Message when `head` does not extend `base` unchanged (an entry recorded on
 * the base branch was edited, removed, or reordered), or `null` when it does.
 * `historyPath` names the history file in the message (the CLI contract keeps its own).
 */
export function rpcContractHistoryViolation(
	base: readonly RpcContractRelease[],
	head: readonly RpcContractRelease[],
	historyPath: string = RPC_CONTRACT_HISTORY_PATH,
): string | null {
	for (let i = 0; i < base.length; i++) {
		const recorded = base[i];
		const current = head[i];
		if (current?.version === recorded.version && current.schemaHash === recorded.schemaHash) continue;
		const found = current ? `{ version: ${current.version}, schemaHash: ${current.schemaHash} }` : "nothing";
		return [
			`${historyPath} must keep every entry already on the base branch unchanged and in order.`,
			`Entry ${i} is { version: ${recorded.version}, schemaHash: ${recorded.schemaHash} } on the base branch but ${found} here.`,
			"Restore it and append a new release instead (see docs/rpc-contract.md).",
		].join("\n");
	}
	return null;
}

/** `packages/rpc-contract/contract.json`: the version and shape hash for non-TypeScript consumers. */
export function emitContractJson(bundle: RpcWireBundle): string {
	const contract = {
		contractVersion: currentRpcContractRelease().version,
		schemaHash: rpcContractSchemaHash(bundle),
		schema: "rpc-wire.schema.json",
	};
	return `${JSON.stringify(contract, null, "\t")}\n`;
}

/** `packages/rpc-contract/src/contract.generated.ts`: the version and shape hash as constants. */
export function emitContractModule(bundle: RpcWireBundle): string {
	return [
		"// Generated by `bun run gen:rpc` from packages/coding-agent/src/modes/rpc/wire. Do not edit.",
		"",
		"/** RPC contract semver; `ready` and the `negotiate_protocol` response report it as `contractVersion`. */",
		`export const RPC_CONTRACT_VERSION = ${JSON.stringify(currentRpcContractRelease().version)};`,
		"",
		"/** `sha256:<hex>` shape hash of `rpc-wire.schema.json` (documentation text and ordering excluded). */",
		`export const RPC_CONTRACT_SCHEMA_HASH = ${JSON.stringify(rpcContractSchemaHash(bundle))};`,
		"",
	].join("\n");
}
