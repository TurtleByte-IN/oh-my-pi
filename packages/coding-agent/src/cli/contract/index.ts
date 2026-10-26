/**
 * CLI JSON contract: the stdout shape of the `--json` commands hosts drive
 * (`omp config list|set|reset`, `omp models`, `omp plugin list`, `omp skill list`).
 *
 * Definitions are omptype schemas, like the RPC wire schema (`modes/rpc/wire`).
 * `buildCliContractBundle` emits them as a JSON Schema 2020-12 bundle with an
 * `x-cli` command table; `bun run gen:rpc` writes it, the TypeScript types, and
 * the contract version into `packages/rpc-contract`. `contract-history.json`
 * records each released version with the bundle's shape hash, and
 * `test/rpc-wire/cli-contract.test.ts` fails when the shape changes without a
 * new entry or when a command's real output stops matching its schema. See
 * `docs/rpc-contract.md`.
 *
 * Objects OMP owns reject undeclared keys, so adding a field is a shape change.
 * Data passed through from third-party files (a plugin's manifest, the
 * Claude-compatible plugin registry, model pricing detail) stays open.
 */
import { MODEL_KINDS, type ModelPricingStatus } from "@oh-my-pi/pi-catalog/types";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { type } from "@oh-my-pi/omptype";
import type { SettingDefinition } from "../../config/registry";
import type { SettingProvenance } from "../../config/settings";
import { doc, type WireDefs } from "../../modes/rpc/wire/dsl";
import history from "./contract-history.json" with { type: "json" };

/** One released CLI contract version and the shape hash of its schema bundle. */
export interface CliContractRelease {
	version: string;
	schemaHash: string;
}

export const CLI_CONTRACT_HISTORY: readonly CliContractRelease[] = history;

/** CLI contract version this build implements: the last `CLI_CONTRACT_HISTORY` entry. */
export const CLI_CONTRACT_VERSION: string = CLI_CONTRACT_HISTORY[CLI_CONTRACT_HISTORY.length - 1].version;

/** One `--json` command: its name, documented usage, and the definition its stdout matches. */
export interface CliContractCommand {
	name: string;
	usage: string;
	output: string;
}

/** JSON Schema bundle of every CLI JSON output. */
export interface CliContractBundle {
	$schema: string;
	$id: string;
	title: string;
	description: string;
	"x-cli": { commands: CliContractCommand[] };
	$defs: Record<string, Record<string, unknown>>;
}

// Keyed by every member of the source union: a value added there fails to compile until listed here.
const SETTING_SOURCES: Record<SettingProvenance, true> = {
	default: true,
	global: true,
	project: true,
	overlay: true,
	runtime: true,
	env: true,
};
const SETTING_TYPES: Record<SettingDefinition["type"], true> = {
	boolean: true,
	string: true,
	number: true,
	enum: true,
	array: true,
	record: true,
};
const PRICING_STATUSES: Record<ModelPricingStatus, true> = {
	fixed: true,
	free: true,
	included: true,
	variable: true,
	unknown: true,
};

function literals(values: Iterable<string>): string {
	return [...values].map(value => `'${value}'`).join(" | ");
}

const configDefs = {
	CliSettingSource: doc(
		literals(Object.keys(SETTING_SOURCES)),
		"Layer supplying a setting's effective value: `default` (schema default), `global` (agent dir `config.yml`), `project` (`<cwd>/.omp/config.yml` and other project settings files), `overlay` (`--config` / `PI_CONFIG_FILES`), `runtime` (process override), `env` (environment variable; read-only for hosts).",
	),
	CliSettingType: doc(literals(Object.keys(SETTING_TYPES)), "Value type of a setting."),
	CliConfigScope: doc("'global' | 'project'", "Config file `config set` and `config reset` write."),
	CliConfigEntry: doc(
		{
			"+": "reject",
			"value?": doc("unknown", "Effective value; absent when the setting has no value or is redacted."),
			"redacted?": doc("true", "Set when a credential is configured: `value` is withheld."),
			type: "CliSettingType",
			description: "string",
			source: "CliSettingSource",
		},
		"One setting in `omp config list --json`.",
	),
	CliConfigList: doc("Record<string, CliConfigEntry>", "`omp config list --json`: every setting by key."),
	CliConfigSetResult: doc(
		{
			"+": "reject",
			key: "string",
			scope: "CliConfigScope",
			"value?": doc("unknown", "Value the scope's config file now holds."),
			"overriddenBy?": doc(
				"string",
				"Higher layer (`project`, `overlay`, `runtime`) or environment variable name that still supplies the effective value.",
			),
			"fallbackEnv?": doc("string", "Environment variable used while the saved value is blank."),
		},
		"`omp config set <key> <value> --json`.",
	),
	CliConfigResetResult: doc(
		{
			"+": "reject",
			key: "string",
			scope: "CliConfigScope",
			"value?": doc("unknown", "Effective value after the reset; absent when unset or redacted."),
			"redacted?": doc("true", "Set when the effective value is a configured credential."),
		},
		"`omp config reset <key> --json`.",
	),
} satisfies WireDefs;

const modelDefs = {
	CliModelKind: literals(MODEL_KINDS),
	CliEffort: literals(THINKING_EFFORTS),
	CliModelPricingStatus: literals(Object.keys(PRICING_STATUSES)),
	CliModelCost: doc(
		{ input: "number", output: "number", cacheRead: "number", cacheWrite: "number" },
		"Effective per-million-token rates now. Further pricing keys (`longContext`, `timeBased`) may be present and are not part of the contract.",
	),
	CliModel: {
		"+": "reject",
		provider: "string",
		kind: "CliModelKind",
		id: "string",
		selector: doc("string", "`provider/id`."),
		name: "string",
		contextWindow: "number | null",
		maxTokens: "number | null",
		reasoning: "boolean",
		thinking: doc("CliEffort[] | null", "Supported thinking efforts when the model thinks, otherwise null."),
		input: "('text' | 'image')[]",
		cost: "CliModelCost",
		pricingStatus: "CliModelPricingStatus",
	},
	CliModelsList: doc({ "+": "reject", models: "CliModel[]" }, "`omp models [ls|find|refresh] --json`."),
} satisfies WireDefs;

const pluginDefs = {
	CliNpmPlugin: {
		"+": "reject",
		name: "string",
		version: "string",
		path: "string",
		manifest: doc(
			"Record<string, unknown>",
			"The package's `omp` (or `pi`) manifest as published, with `version` copied from package.json.",
		),
		enabledFeatures: doc("string[] | null", "Enabled features; null uses the manifest defaults."),
		enabled: "boolean",
	},
	CliMarketplacePluginEntry: doc(
		{
			"scope?": doc("'user' | 'project'", "Absent in registries written before scopes existed (user)."),
			installPath: "string",
			version: "string",
			installedAt: "string",
			lastUpdated: "string",
			"gitCommitSha?": "string",
			"enabled?": "boolean",
		},
		"One install record from the Claude-compatible `installed_plugins.json` registry; other keys pass through.",
	),
	CliMarketplacePlugin: {
		"+": "reject",
		id: "string",
		scope: "'user' | 'project'",
		entries: "CliMarketplacePluginEntry[]",
		"shadowedBy?": doc("'project'", "Set on a user install that an enabled project install overrides."),
	},
	CliPluginList: doc(
		{ "+": "reject", npm: "CliNpmPlugin[]", marketplace: "CliMarketplacePlugin[]" },
		"`omp plugin list --json`.",
	),
} satisfies WireDefs;

const skillDefs = {
	CliSkill: {
		"+": "reject",
		name: "string",
		description: "string",
		filePath: "string",
		baseDir: "string",
		source: "string",
		hide: "boolean",
	},
	CliSkillWarning: { "+": "reject", skillPath: "string", message: "string" },
	CliSkillList: doc(
		{ "+": "reject", skills: "CliSkill[]", warnings: "CliSkillWarning[]" },
		"`omp skill list [dir] --json`.",
	),
} satisfies WireDefs;

const cliDefs: WireDefs = { ...configDefs, ...modelDefs, ...pluginDefs, ...skillDefs };

/** Every `--json` command in the contract. */
export const CLI_CONTRACT_COMMANDS: readonly CliContractCommand[] = [
	{ name: "config list", usage: "omp config list --json [--cwd <path>]", output: "CliConfigList" },
	{
		name: "config set",
		usage: "omp config set <key> <value> --json [--scope global|project] [--cwd <path>]",
		output: "CliConfigSetResult",
	},
	{
		name: "config reset",
		usage: "omp config reset <key> --json [--scope global|project] [--cwd <path>]",
		output: "CliConfigResetResult",
	},
	{ name: "models", usage: "omp models [ls|find|refresh] [pattern] --json [--kind <kind>]", output: "CliModelsList" },
	{ name: "plugin list", usage: "omp plugin list --json", output: "CliPluginList" },
	{ name: "skill list", usage: "omp skill list [dir] --json", output: "CliSkillList" },
];

/** A validator per definition: returns the data, or `type.errors` describing the mismatch. */
export type CliContractValidator = (data: unknown) => unknown;

/** Validators for every definition, by name (`CliConfigList`, `CliModelsList`, …). */
export function cliContractValidators(): Record<string, CliContractValidator> {
	return type.scope(cliDefs).export() as unknown as Record<string, CliContractValidator>;
}

/** Emits the JSON Schema bundle consumed by `bun run gen:rpc` and hosts. */
export function buildCliContractBundle(): CliContractBundle {
	const exported = type.scope(cliDefs).export() as Record<string, { toJsonSchema(): Record<string, unknown> }>;
	const $defs: Record<string, Record<string, unknown>> = {};
	for (const name in cliDefs) {
		const { $defs: _nested, ...root } = exported[name].toJsonSchema();
		$defs[name] = root;
	}
	for (const command of CLI_CONTRACT_COMMANDS) {
		if (!(command.output in $defs))
			throw new Error(`CLI command ${command.name} names unknown output ${command.output}`);
	}
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: "https://omp.sh/schemas/cli-contract.json",
		title: "omp CLI JSON outputs",
		description:
			"Generated by `bun run gen:rpc` from packages/coding-agent/src/cli/contract. Each `x-cli` command prints one JSON document matching its `output` definition on stdout.",
		"x-cli": { commands: CLI_CONTRACT_COMMANDS.map(command => ({ ...command })) },
		$defs,
	};
}
