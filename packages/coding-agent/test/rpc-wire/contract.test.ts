import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { compareVersions } from "@oh-my-pi/pi-utils";
import { buildRpcWireBundle, type RpcWireBundle } from "../../src/modes/rpc/wire";
import { RPC_CONTRACT_HISTORY, RPC_CONTRACT_VERSION, type RpcContractRelease } from "../../src/modes/rpc/wire/contract";
import {
	RPC_CONTRACT_HISTORY_PATH,
	rpcContractDrift,
	rpcContractHistoryViolation,
	rpcContractSchemaHash,
} from "../../scripts/gen-rpc/contract";

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CONTRACT_PACKAGE_JSON = path.resolve(import.meta.dir, "../../../rpc-contract/package.json");

// The branch whose recorded history must stay an unchanged prefix. CI sets the
// variable after fetching the PR base (a shallow `+refs/heads/<base>:refs/remotes/origin/<base>`
// fetch is enough), which makes the check mandatory; locally it runs when `origin/main` exists.
const BASE_REF_REQUIRED = Bun.env.OMP_RPC_CONTRACT_BASE_REF;
const BASE_REF = BASE_REF_REQUIRED || "origin/main";
const REPO = vcs.git(import.meta.dir);
const BASE_AVAILABLE = REPO !== null && (await REPO.refExists(BASE_REF));

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

	test("history is semver in ascending order and ends at RPC_CONTRACT_VERSION", () => {
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

	test("the order of required, enum, and properties does not change the shape hash", () => {
		const base = rpcContractSchemaHash(buildRpcWireBundle());
		const bundle = buildRpcWireBundle();
		const promptResult = definition(bundle, "PromptResultEvent");
		const required = promptResult.required as string[];
		expect(required.length).toBeGreaterThan(1);
		promptResult.required = required.toReversed();
		promptResult.properties = Object.fromEntries(Object.entries(properties(bundle, "PromptResultEvent")).reverse());
		const status = definition(bundle, "PromptStatus");
		status.enum = (status.enum as string[]).toReversed();
		expect(rpcContractSchemaHash(bundle)).toBe(base);
	});

	test("the order of clientOmit does not change the shape hash", () => {
		const forward = buildRpcWireBundle();
		const backward = buildRpcWireBundle();
		forward["x-rpc"].commands[0].clientOmit = ["a", "b"];
		backward["x-rpc"].commands[0].clientOmit = ["b", "a"];
		expect(rpcContractSchemaHash(forward)).toBe(rpcContractSchemaHash(backward));
	});

	test.skipIf(!BASE_REF_REQUIRED && !BASE_AVAILABLE)(
		`every release recorded on ${BASE_REF} is kept unchanged and in order`,
		async () => {
			if (!REPO || !BASE_AVAILABLE)
				throw new Error(`${BASE_REF} is not available: fetch it before running the append-only check`);
			let base: RpcContractRelease[] = [];
			try {
				const blob = await REPO.showBlob(`${BASE_REF}:${RPC_CONTRACT_HISTORY_PATH}`);
				base = JSON.parse(blob.data.toString("utf8")) as RpcContractRelease[];
			} catch (error) {
				// The base predates the history file: nothing is recorded yet.
				if (!(vcs.isVcsError(error) && error.code === "ObjectNotFound")) throw error;
			}
			const violation = rpcContractHistoryViolation(base, RPC_CONTRACT_HISTORY);
			if (violation) throw new Error(violation);
		},
	);

	test("history violations: base entries must stay an unchanged prefix", () => {
		const v1 = { version: "1.0.0", schemaHash: `sha256:${"1".repeat(64)}` };
		const v2 = { version: "1.1.0", schemaHash: `sha256:${"2".repeat(64)}` };
		const v3 = { version: "2.0.0", schemaHash: `sha256:${"3".repeat(64)}` };
		expect(rpcContractHistoryViolation([], [v1])).toBeNull();
		expect(rpcContractHistoryViolation([v1, v2], [v1, v2])).toBeNull();
		expect(rpcContractHistoryViolation([v1, v2], [v1, v2, v3])).toBeNull();
		expect(rpcContractHistoryViolation([v1, v2], [v1, { ...v2, schemaHash: v3.schemaHash }])).toContain("Entry 1");
		expect(rpcContractHistoryViolation([v1, v2], [v1, { ...v2, version: "1.2.0" }])).toContain("Entry 1");
		expect(rpcContractHistoryViolation([v1, v2], [v1])).toContain("but nothing here");
		expect(rpcContractHistoryViolation([v1, v2], [v2, v1])).toContain("Entry 0");
		expect(rpcContractHistoryViolation([v1, v2], [v1, v3])).toContain("Entry 1");
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
