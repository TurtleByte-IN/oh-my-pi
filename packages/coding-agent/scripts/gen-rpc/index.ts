/**
 * `bun run gen:rpc`: regenerates every artifact derived from the RPC wire schema.
 *
 * Outputs (all committed; `test/rpc-wire/generated.test.ts` fails when stale):
 * - `src/modes/rpc/wire/rpc-wire.schema.json`: the language-neutral bundle
 * - `src/modes/rpc/wire/rpc-wire.generated.ts`: TypeScript wire types
 * - `packages/rpc-contract`: the bundle, the TypeScript types, and the contract
 *   version and shape hash (`contract.json`, `src/contract.generated.ts`), plus
 *   the CLI JSON contract from `src/cli/contract` (`cli-contract.schema.json`,
 *   `cli-contract.json`, `src/cli.generated.ts`)
 * - `sdk/python/omp-rpc/src/omp_rpc/_wire.py`: Python types, parsers, and client methods
 * - `sdk/rust/omp-rpc/src/wire.rs`: Rust serde types, frame decoders, and `Command` impls
 * - `sdk/go/omp-rpc/wire.go`: Go types, frame decoders, and `Commands` methods
 *
 * Exits non-zero after writing when the wire shape or the CLI JSON shape no
 * longer matches its recorded contract version (`test/rpc-wire/contract.test.ts`
 * and `test/rpc-wire/cli-contract.test.ts` enforce the same).
 */
import * as path from "node:path";
import { buildCliContractBundle } from "../../src/cli/contract";
import { buildRpcWireBundle } from "../../src/modes/rpc/wire";
import { cliContractDrift, emitCliContractJson, emitCliContractModule } from "./cli-contract";
import { emitContractJson, emitContractModule, rpcContractDrift } from "./contract";
import { emitGo } from "./go";
import { buildWireModel } from "./model";
import { emitPython } from "./python";
import { emitRust } from "./rust";
import { emitTypeScript } from "./typescript";

const PACKAGE_DIR = path.resolve(import.meta.dir, "../..");
const WIRE_DIR = path.join(PACKAGE_DIR, "src/modes/rpc/wire");
const CONTRACT_DIR = path.resolve(PACKAGE_DIR, "../rpc-contract");
const SDK_DIR = path.resolve(PACKAGE_DIR, "../../sdk");

/** Generated file path → contents. */
export function generateRpcArtifacts(): Map<string, string> {
	const bundle = buildRpcWireBundle();
	const model = buildWireModel(bundle);
	const schema = `${JSON.stringify(bundle, null, "\t")}\n`;
	const types = emitTypeScript(model);
	const cliBundle = buildCliContractBundle();
	return new Map([
		[path.join(WIRE_DIR, "rpc-wire.schema.json"), schema],
		[path.join(WIRE_DIR, "rpc-wire.generated.ts"), types],
		[path.join(CONTRACT_DIR, "rpc-wire.schema.json"), schema],
		[path.join(CONTRACT_DIR, "contract.json"), emitContractJson(bundle)],
		[path.join(CONTRACT_DIR, "src/wire.generated.ts"), types],
		[path.join(CONTRACT_DIR, "src/contract.generated.ts"), emitContractModule(bundle)],
		[path.join(CONTRACT_DIR, "cli-contract.schema.json"), `${JSON.stringify(cliBundle, null, "\t")}\n`],
		[path.join(CONTRACT_DIR, "cli-contract.json"), emitCliContractJson(cliBundle)],
		[path.join(CONTRACT_DIR, "src/cli.generated.ts"), emitCliContractModule(cliBundle)],
		[path.join(SDK_DIR, "python/omp-rpc/src/omp_rpc/_wire.py"), emitPython(model)],
		[path.join(SDK_DIR, "rust/omp-rpc/src/wire.rs"), emitRust(model)],
		[path.join(SDK_DIR, "go/omp-rpc/wire.go"), emitGo(model)],
	]);
}

if (import.meta.main) {
	for (const [file, contents] of generateRpcArtifacts()) {
		await Bun.write(file, contents);
		console.log(`wrote ${path.relative(process.cwd(), file)}`);
	}
	for (const drift of [rpcContractDrift(buildRpcWireBundle()), cliContractDrift(buildCliContractBundle())]) {
		if (!drift) continue;
		console.error(drift);
		process.exitCode = 1;
	}
}
