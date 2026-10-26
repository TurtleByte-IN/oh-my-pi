import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { compareVersions } from "@oh-my-pi/pi-utils";
import { buildRpcWireBundle, type RpcWireBundle } from "../../src/modes/rpc/wire";
import { RPC_CONTRACT_HISTORY, RPC_CONTRACT_VERSION } from "../../src/modes/rpc/wire/contract";
import { rpcContractDrift, rpcContractSchemaHash } from "../../scripts/gen-rpc/contract";

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CONTRACT_PACKAGE_JSON = path.resolve(import.meta.dir, "../../../rpc-contract/package.json");

function definition(bundle: RpcWireBundle, name: string): Record<string, unknown> {
	const def = bundle.$defs[name];
	if (!def) throw new Error(`missing definition ${name}`);
	return def;
}

function properties(bundle: RpcWireBundle, name: string): Record<string, Record<string, unknown>> {
	const props = definition(bundle, name).properties;
	if (!props || typeof props !== "object") throw new Error(`${name} has no properties`);
	return props as Record<string, Record<string, unknown>>;
}

describe("RPC contract version", () => {
	test("the wire shape matches the hash recorded for the current contract version", () => {
		const drift = rpcContractDrift(buildRpcWireBundle());
		if (drift) throw new Error(drift);
	});

	test("history is append-only semver in ascending order and ends at RPC_CONTRACT_VERSION", () => {
		expect(RPC_CONTRACT_HISTORY.length).toBeGreaterThan(0);
		for (const release of RPC_CONTRACT_HISTORY) {
			expect(release.version).toMatch(SEMVER);
			expect(release.schemaHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		}
		for (let i = 1; i < RPC_CONTRACT_HISTORY.length; i++) {
			expect(compareVersions(RPC_CONTRACT_HISTORY[i].version, RPC_CONTRACT_HISTORY[i - 1].version)).toBe(1);
		}
		expect(RPC_CONTRACT_HISTORY.at(-1)?.version).toBe(RPC_CONTRACT_VERSION);
	});

	test("packages/rpc-contract is versioned as the contract", async () => {
		const manifest = (await Bun.file(CONTRACT_PACKAGE_JSON).json()) as { version: string };
		expect(manifest.version).toBe(RPC_CONTRACT_VERSION);
	});

	test("documentation and authoring order do not change the shape hash", () => {
		const base = rpcContractSchemaHash(buildRpcWireBundle());
		const bundle = buildRpcWireBundle();
		bundle.description = "reworded";
		definition(bundle, "ReadyEvent").description = "reworded";
		properties(bundle, "ReadyEvent").contractVersion.description = "reworded";
		bundle["x-rpc"].commands[0].doc = "reworded";
		bundle["x-rpc"].commands.reverse();
		bundle.$defs = Object.fromEntries(Object.entries(bundle.$defs).reverse());
		expect(rpcContractSchemaHash(bundle)).toBe(base);
	});

	test.each<[string, (bundle: RpcWireBundle) => void]>([
		["an added frame field", bundle => (properties(bundle, "ReadyEvent").extra = { type: "string" })],
		["a removed frame field", bundle => delete properties(bundle, "ReadyEvent").maxFrameBytes],
		["a changed field type", bundle => (properties(bundle, "ReadyEvent").contractVersion = { type: "integer" })],
		["a newly required field", bundle => (definition(bundle, "ReadyEvent").required = ["type", "contractVersion"])],
		[
			"an added enum value",
			bundle => (definition(bundle, "PromptStatus").enum = ["completed", "aborted", "error", "x"]),
		],
		["a renamed command", bundle => (bundle["x-rpc"].commands[0].name = "negotiate")],
		["a changed command result", bundle => (bundle["x-rpc"].commands[0].result = "PromptAck")],
		[
			"an added command",
			bundle =>
				bundle["x-rpc"].commands.push({ ...bundle["x-rpc"].commands[0], name: "set_approval_mode", doc: "" }),
		],
		["an added definition", bundle => (bundle.$defs.ExtraEvent = { type: "object" })],
	])("%s changes the shape hash and fails without a version bump", (_label, mutate) => {
		const bundle = buildRpcWireBundle();
		mutate(bundle);
		expect(rpcContractSchemaHash(bundle)).not.toBe(rpcContractSchemaHash(buildRpcWireBundle()));
		expect(rpcContractDrift(bundle)).toContain("The RPC wire shape changed");
	});
});
