import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as path from "node:path";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { compareVersions, getConfigRootDir, getPluginsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { type } from "@oh-my-pi/omptype";
import {
	buildCliContractBundle,
	CLI_CONTRACT_COMMANDS,
	CLI_CONTRACT_HISTORY,
	CLI_CONTRACT_VERSION,
	type CliContractBundle,
	type CliContractRelease,
	cliContractValidators,
} from "../../src/cli/contract";
import { runConfigCommand } from "../../src/cli/config-cli";
import { renderProviderModels } from "../../src/cli/models-cli";
import { resetSettingsForTest } from "../../src/config/settings";
import { AgentStorage } from "../../src/session/agent-storage";
import { CLI_CONTRACT_HISTORY_PATH, cliContractDrift, cliContractSchemaHash } from "../../scripts/gen-rpc/cli-contract";
import { rpcContractHistoryViolation } from "../../scripts/gen-rpc/contract";

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CLI_ENTRY = path.resolve(import.meta.dir, "../../src/cli.ts");

// Same base-branch rule as contract.test.ts: mandatory when OMP_RPC_CONTRACT_BASE_REF is set (CI).
const BASE_REF_REQUIRED = Bun.env.OMP_RPC_CONTRACT_BASE_REF;
const BASE_REF = BASE_REF_REQUIRED || "origin/main";
const REPO = vcs.git(import.meta.dir);
const BASE_AVAILABLE = REPO !== null && (await REPO.refExists(BASE_REF));

const validators = cliContractValidators();

/** Throws with the validator's summary when `data` does not match definition `name`. */
function expectConforms(name: string, data: unknown): void {
	const validate = validators[name];
	if (!validate) throw new Error(`no CLI contract definition ${name}`);
	const result = validate(data);
	if (result instanceof type.errors) throw new Error(`${name}: ${result.summary}`);
}

function conforms(name: string, data: unknown): boolean {
	return !(validators[name](data) instanceof type.errors);
}

function definition(bundle: CliContractBundle, name: string): Record<string, unknown> {
	const def = bundle.$defs[name];
	if (!def) throw new Error(`missing definition ${name}`);
	return def;
}

function properties(bundle: CliContractBundle, name: string): Record<string, Record<string, unknown>> {
	return definition(bundle, name).properties as Record<string, Record<string, unknown>>;
}

describe("CLI contract version", () => {
	test("the CLI JSON shape matches the hash recorded for the current CLI contract version", () => {
		const drift = cliContractDrift(buildCliContractBundle());
		if (drift) throw new Error(drift);
	});

	test("history is semver in ascending order and ends at CLI_CONTRACT_VERSION", () => {
		expect(CLI_CONTRACT_HISTORY.length).toBeGreaterThan(0);
		for (const release of CLI_CONTRACT_HISTORY) {
			expect(release.version).toMatch(SEMVER);
			expect(release.schemaHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		}
		for (let i = 1; i < CLI_CONTRACT_HISTORY.length; i++) {
			expect(compareVersions(CLI_CONTRACT_HISTORY[i].version, CLI_CONTRACT_HISTORY[i - 1].version)).toBe(1);
		}
		expect(CLI_CONTRACT_HISTORY.at(-1)?.version).toBe(CLI_CONTRACT_VERSION);
	});

	test("every command names a definition", () => {
		const bundle = buildCliContractBundle();
		for (const command of CLI_CONTRACT_COMMANDS) expect(bundle.$defs[command.output]).toBeDefined();
	});

	test("documentation and authoring order do not change the shape hash", () => {
		const base = cliContractSchemaHash(buildCliContractBundle());
		const bundle = buildCliContractBundle();
		bundle.description = "reworded";
		definition(bundle, "CliConfigEntry").description = "reworded";
		properties(bundle, "CliConfigEntry").value.description = "reworded";
		bundle["x-cli"].commands[0].usage = "reworded";
		bundle["x-cli"].commands.reverse();
		bundle.$defs = Object.fromEntries(Object.entries(bundle.$defs).reverse());
		const entry = definition(bundle, "CliConfigEntry");
		entry.required = (entry.required as string[]).toReversed();
		const source = definition(bundle, "CliSettingSource");
		source.enum = (source.enum as string[]).toReversed();
		expect(cliContractSchemaHash(bundle)).toBe(base);
	});

	test.skipIf(!BASE_REF_REQUIRED && !BASE_AVAILABLE)(
		`every CLI release recorded on ${BASE_REF} is kept unchanged and in order`,
		async () => {
			if (!REPO || !BASE_AVAILABLE)
				throw new Error(`${BASE_REF} is not available: fetch it before running the append-only check`);
			let base: CliContractRelease[] = [];
			try {
				const blob = await REPO.showBlob(`${BASE_REF}:${CLI_CONTRACT_HISTORY_PATH}`);
				base = JSON.parse(blob.data.toString("utf8")) as CliContractRelease[];
			} catch (error) {
				// The base predates the CLI contract: nothing is recorded yet.
				if (!(vcs.isVcsError(error) && error.code === "ObjectNotFound")) throw error;
			}
			const violation = rpcContractHistoryViolation(base, CLI_CONTRACT_HISTORY, CLI_CONTRACT_HISTORY_PATH);
			if (violation) throw new Error(violation);
		},
	);

	test.each<[string, (bundle: CliContractBundle) => void]>([
		["an added output field", bundle => (properties(bundle, "CliConfigEntry").extra = { type: "string" })],
		["a removed output field", bundle => delete properties(bundle, "CliModel").selector],
		["a changed field type", bundle => (properties(bundle, "CliSkill").hide = { type: "string" })],
		["a newly required field", bundle => (definition(bundle, "CliConfigSetResult").required = ["key", "value"])],
		["an added source layer", bundle => (definition(bundle, "CliSettingSource").enum = ["default", "cli"])],
		["a renamed command", bundle => (bundle["x-cli"].commands[0].name = "config ls")],
		["a changed command output", bundle => (bundle["x-cli"].commands[0].output = "CliSkillList")],
		["an added definition", bundle => (bundle.$defs.CliExtra = { type: "object" })],
	])("%s changes the shape hash and fails without a version bump", (_label, mutate) => {
		const bundle = buildCliContractBundle();
		mutate(bundle);
		expect(cliContractSchemaHash(bundle)).not.toBe(cliContractSchemaHash(buildCliContractBundle()));
		expect(cliContractDrift(bundle)).toContain("The CLI JSON shape changed");
	});

	test("an output that drifts from its schema is rejected", () => {
		const entry = { value: 1, type: "number", description: "", source: "global" };
		expect(conforms("CliConfigList", { a: entry })).toBe(true);
		expect(conforms("CliConfigList", { a: { ...entry, source: undefined } })).toBe(false);
		expect(conforms("CliConfigList", { a: { ...entry, source: "cli" } })).toBe(false);
		expect(conforms("CliConfigList", { a: { ...entry, origin: "global" } })).toBe(false);
		expect(conforms("CliSkillList", { skills: [], warnings: [], total: 0 })).toBe(false);
	});
});

interface CliResult {
	exitCode: number;
	output: string;
	error: string;
}

/** Runs the real CLI against an isolated home: no ambient config, plugins, or skills. */
async function runCli(args: string[], home: string, cwd: string, env: Record<string, string> = {}): Promise<CliResult> {
	const base: Record<string, string | undefined> = { ...process.env };
	for (const name of Object.keys(base)) {
		if (name.startsWith("XDG_") || name.startsWith("PI_") || name.startsWith("HINDSIGHT_")) delete base[name];
	}
	const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...base, HOME: home, USERPROFILE: home, NO_COLOR: "1", ...env },
	});
	const [exitCode, output, error] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, output, error };
}

async function runJson(args: string[], home: string, cwd: string, env?: Record<string, string>): Promise<unknown> {
	const result = await runCli(args, home, cwd, env);
	if (result.exitCode !== 0) throw new Error(`omp ${args.join(" ")} exited ${result.exitCode}: ${result.error}`);
	return JSON.parse(result.output);
}

describe("CLI JSON outputs match the contract", () => {
	let home: TempDir;
	let project: TempDir;

	beforeAll(() => {
		home = TempDir.createSync("@omp-cli-contract-home-");
		project = TempDir.createSync("@omp-cli-contract-project-");
	});

	afterAll(async () => {
		await Promise.all([home.remove(), project.remove()]).catch(() => {});
	});

	test("config list --json, with every source layer and a redacted credential", async () => {
		const agentDir = path.join(home.path(), ".omp", "agent");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"compaction:\n  enabled: false\nhindsight:\n  apiToken: secret-token\n",
		);
		await Bun.write(path.join(project.path(), ".omp", "config.yml"), "defaultThinkingLevel: high\n");
		const overlay = path.join(home.path(), "overlay.yml");
		await Bun.write(overlay, "compaction:\n  idleTimeoutSeconds: 42\n");

		const listed = (await runJson(["config", "list", "--json", "--cwd", project.path()], home.path(), home.path(), {
			HINDSIGHT_BANK_ID: "from-env",
			PI_CONFIG_FILES: overlay,
		})) as Record<string, { source: string; redacted?: true }>;

		expectConforms("CliConfigList", listed);
		expect(new Set(Object.values(listed).map(entry => entry.source))).toEqual(
			new Set(["default", "global", "project", "overlay", "env"]),
		);
		expect(listed["hindsight.apiToken"]).toMatchObject({ redacted: true });
	});

	test("config list --scope global --json, with a path-scoped entry and a redacted credential", async () => {
		const scopedHome = TempDir.createSync("@omp-cli-contract-layer-");
		try {
			await Bun.write(
				path.join(scopedHome.path(), ".omp", "agent", "config.yml"),
				`enabledModels:\n  - path: ${project.path()}\n    models: [openai/gpt-5]\nhindsight:\n  apiToken: secret-token\n`,
			);

			const listed = (await runJson(
				["config", "list", "--scope", "global", "--json"],
				scopedHome.path(),
				scopedHome.path(),
			)) as Record<string, { value?: unknown; redacted?: true }>;

			expectConforms("CliConfigLayerList", listed);
			expect(listed.enabledModels.value).toEqual([{ path: project.path(), models: ["openai/gpt-5"] }]);
			expect(listed["hindsight.apiToken"]).toMatchObject({ redacted: true });
		} finally {
			await scopedHome.remove().catch(() => {});
		}
	});

	test("skill list [dir] --json", async () => {
		const skillDir = path.join(project.path(), ".omp", "skills", "demo");
		await Bun.write(
			path.join(skillDir, "SKILL.md"),
			"---\nname: demo\ndescription: Demo skill for the contract test\n---\n\nBody.\n",
		);

		const listed = (await runJson(["skill", "list", project.path(), "--json"], home.path(), home.path())) as {
			skills: { name: string }[];
		};

		expectConforms("CliSkillList", listed);
		expect(listed.skills.map(skill => skill.name)).toContain("demo");
	});

	test("plugin list --json, with a linked npm plugin and a marketplace install", async () => {
		const pluginDir = path.join(project.path(), "demo-plugin");
		await Bun.write(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "omp-contract-demo-plugin",
				version: "1.2.3",
				omp: { description: "Demo plugin", features: { extra: { description: "Extra", default: false } } },
			}),
		);
		const linked = await runCli(["plugin", "link", pluginDir], home.path(), project.path());
		if (linked.exitCode !== 0) throw new Error(`plugin link failed: ${linked.error}`);
		const now = new Date(0).toISOString();
		await Bun.write(
			path.join(getPluginsDir(home.path()), "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"demo@market": [
						{
							scope: "user",
							installPath: path.join(home.path(), "cache", "demo"),
							version: "0.1.0",
							installedAt: now,
							lastUpdated: now,
						},
					],
				},
			}),
		);

		const listed = (await runJson(["plugin", "list", "--json"], home.path(), project.path())) as {
			npm: { name: string }[];
			marketplace: { id: string }[];
		};

		expectConforms("CliPluginList", listed);
		expect(listed.npm.map(plugin => plugin.name)).toContain("omp-contract-demo-plugin");
		expect(listed.marketplace.map(plugin => plugin.id)).toContain("demo@market");
	});
});

describe("models --json matches the contract", () => {
	afterEach(() => vi.restoreAllMocks());

	test("every bundled catalog model renders a conforming row", () => {
		const models = getBundledProviders().flatMap(provider => getBundledModels(provider as GeneratedProvider));
		expect(models.length).toBeGreaterThan(0);
		const output: string[] = [];
		spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		renderProviderModels({ getAvailable: () => models, getError: () => undefined }, "ls", undefined, true, "all");
		vi.restoreAllMocks();

		const listed = JSON.parse(output.join("")) as { models: unknown[] };
		expect(listed.models.length).toBe(models.length);
		expectConforms("CliModelsList", listed);
	});
});

describe("config set/reset --json match the contract", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	let agentDir: TempDir;
	let project: TempDir;

	beforeEach(() => {
		resetSettingsForTest();
		agentDir = TempDir.createSync("@omp-cli-contract-agent-");
		project = TempDir.createSync("@omp-cli-contract-set-");
		setAgentDir(agentDir.path());
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentStorage.close();
		resetSettingsForTest();
		if (originalAgentDir) setAgentDir(originalAgentDir);
		else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await Promise.all([agentDir.remove(), project.remove()]).catch(() => {});
	});

	test("global and project writes, a shadowed write, and resets", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const cwd = project.path();
		const outputs: [string, Record<string, unknown>][] = [];
		const record = (name: string) => outputs.push([name, JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))]);

		await runConfigCommand({ action: "set", key: "compaction.enabled", value: "false", flags: { json: true, cwd } });
		record("CliConfigSetResult");
		await runConfigCommand({
			action: "set",
			key: "compaction.enabled",
			value: "true",
			flags: { json: true, cwd, scope: "project" },
		});
		record("CliConfigSetResult");
		await runConfigCommand({ action: "set", key: "compaction.enabled", value: "false", flags: { json: true, cwd } });
		record("CliConfigSetResult");
		await runConfigCommand({
			action: "set",
			key: "hindsight.apiToken",
			value: "secret-token",
			flags: { json: true, cwd },
		});
		record("CliConfigSetResult");
		await runConfigCommand({ action: "reset", key: "hindsight.apiToken", flags: { json: true, cwd } });
		record("CliConfigResetResult");
		await runConfigCommand({
			action: "reset",
			key: "compaction.enabled",
			flags: { json: true, cwd, scope: "project" },
		});
		record("CliConfigResetResult");

		for (const [name, output] of outputs) expectConforms(name, output);
		expect(outputs[2][1]).toMatchObject({ scope: "global", overriddenBy: "project" });
	});
});
