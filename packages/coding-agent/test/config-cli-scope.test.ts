import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runConfigCommand } from "@oh-my-pi/pi-coding-agent/cli/config-cli";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

let agentDir: TempDir;
let projectDir: TempDir;
let otherDir: TempDir;

interface CliResult {
	exitCode: number;
	output: string;
	error: string;
}

/** Runs the real CLI with the test agent dir and no ambient overlays or Hindsight variables. */
async function runCli(
	args: string[],
	options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CliResult> {
	const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1" };
	for (const name of Object.keys(env)) {
		if (name.startsWith("HINDSIGHT_") || name === "PI_CONFIG_FILES") delete env[name];
	}
	Object.assign(env, { PI_CODING_AGENT_DIR: agentDir.path() }, options.env);
	const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd: options.cwd ?? otherDir.path(),
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const [exitCode, output, error] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, output, error };
}

async function listJson(
	options: { cwd?: string; env?: Record<string, string>; args?: string[] } = {},
): Promise<Record<string, { value?: unknown; source: string }>> {
	const result = await runCli(["config", "list", "--json", ...(options.args ?? [])], options);
	expect(result.error).toBe("");
	expect(result.exitCode).toBe(0);
	return JSON.parse(result.output);
}

function projectConfigFile(): string {
	return path.join(projectDir.path(), ".omp", "config.yml");
}

/** The last JSON line `console.log` printed. */
function lastJson(spy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
	return JSON.parse(String(spy.mock.calls.at(-1)?.[0]));
}

beforeEach(() => {
	resetSettingsForTest();
	agentDir = TempDir.createSync("@omp-config-scope-agent-");
	projectDir = TempDir.createSync("@omp-config-scope-project-");
	otherDir = TempDir.createSync("@omp-config-scope-other-");
	setAgentDir(agentDir.path());
});

afterEach(async () => {
	vi.restoreAllMocks();
	AgentStorage.close();
	resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	await Promise.all([agentDir.remove(), projectDir.remove(), otherDir.remove()]).catch(() => {});
});

describe("config list --json source layer", () => {
	it("reports the layer that supplies each key: default, global, project, overlay, env", async () => {
		await Bun.write(
			path.join(agentDir.path(), "config.yml"),
			"compaction:\n  enabled: false\nhindsight:\n  bankId: from-global\n",
		);
		await Bun.write(projectConfigFile(), "defaultThinkingLevel: high\n");
		const overlay = path.join(agentDir.path(), "overlay.yml");
		await Bun.write(overlay, "compaction:\n  idleTimeoutSeconds: 42\n");

		const listed = await listJson({
			args: ["--cwd", projectDir.path()],
			env: { HINDSIGHT_BANK_ID: "from-env", PI_CONFIG_FILES: overlay },
		});

		expect(listed["compaction.enabled"]).toMatchObject({ value: false, source: "global" });
		expect(listed.defaultThinkingLevel).toMatchObject({ value: "high", source: "project" });
		expect(listed["compaction.idleTimeoutSeconds"]).toMatchObject({ value: 42, source: "overlay" });
		expect(listed["hindsight.bankId"]).toMatchObject({ value: "from-env", source: "env" });
		expect(listed.steeringMode).toMatchObject({ source: "default" });
	});

	it("reads the project layer of --cwd, not of the process directory", async () => {
		await Bun.write(projectConfigFile(), "defaultThinkingLevel: high\n");

		const elsewhere = await listJson();
		expect(elsewhere.defaultThinkingLevel.source).toBe("default");

		const scoped = await listJson({ args: ["--cwd", projectDir.path()] });
		expect(scoped.defaultThinkingLevel).toMatchObject({ value: "high", source: "project" });
	});

	it("fails on a --cwd that is not a directory", async () => {
		const result = await runCli(["config", "list", "--json", "--cwd", path.join(projectDir.path(), "missing")]);
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Not a directory");
	});
});

describe("config set/reset --scope project", () => {
	it("writes <cwd>/.omp/config.yml and leaves the global config.yml alone", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({
			action: "set",
			key: "compaction.enabled",
			value: "false",
			flags: { json: true, scope: "project", cwd: projectDir.path() },
		});

		expect(lastJson(logSpy)).toEqual({ key: "compaction.enabled", scope: "project", value: false });
		expect(YAML.parse(await Bun.file(projectConfigFile()).text())).toEqual({ compaction: { enabled: false } });
		expect(fs.existsSync(path.join(agentDir.path(), "config.yml"))).toBe(false);

		const listed = await listJson({ args: ["--cwd", projectDir.path()] });
		expect(listed["compaction.enabled"]).toMatchObject({ value: false, source: "project" });
	});

	it("keeps other keys of the project file and removes only the reset key", async () => {
		await Bun.write(projectConfigFile(), "defaultThinkingLevel: high\ncompaction:\n  enabled: false\n");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({
			action: "reset",
			key: "compaction.enabled",
			flags: { json: true, scope: "project", cwd: projectDir.path() },
		});

		expect(lastJson(logSpy)).toEqual({ key: "compaction.enabled", scope: "project", value: true });
		expect(YAML.parse(await Bun.file(projectConfigFile()).text())).toEqual({ defaultThinkingLevel: "high" });
	});

	it("reports an environment variable that still overrides the project value", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const previous = process.env.HINDSIGHT_BANK_ID;
		process.env.HINDSIGHT_BANK_ID = "from-env";
		try {
			await runConfigCommand({
				action: "set",
				key: "hindsight.bankId",
				value: "from-project",
				flags: { json: true, scope: "project", cwd: projectDir.path() },
			});
		} finally {
			if (previous === undefined) delete process.env.HINDSIGHT_BANK_ID;
			else process.env.HINDSIGHT_BANK_ID = previous;
		}

		expect(lastJson(logSpy)).toEqual({
			key: "hindsight.bankId",
			scope: "project",
			value: "from-project",
			overriddenBy: "HINDSIGHT_BANK_ID",
		});
		expect(YAML.parse(await Bun.file(projectConfigFile()).text())).toEqual({ hindsight: { bankId: "from-project" } });
	});

	it("validates the value before anything is written", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as typeof process.exit);

		await expect(
			runConfigCommand({
				action: "set",
				key: "defaultThinkingLevel",
				value: "bogus",
				flags: { json: true, scope: "project", cwd: projectDir.path() },
			}),
		).rejects.toThrow("process.exit");
		expect(fs.existsSync(projectConfigFile())).toBe(false);
	});

	/** Runs a project-scope `set` expected to fail; returns what it printed to stderr. */
	async function rejectedProjectSet(): Promise<string> {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as typeof process.exit);
		await expect(
			runConfigCommand({
				action: "set",
				key: "compaction.enabled",
				value: "false",
				flags: { json: true, scope: "project", cwd: projectDir.path() },
			}),
		).rejects.toThrow("process.exit");
		return errorSpy.mock.calls.map(call => String(call[0])).join("\n");
	}

	it("refuses to follow a symlinked .omp directory out of the project", async () => {
		const outside = path.join(otherDir.path(), "elsewhere");
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(projectDir.path(), ".omp"), "dir");

		expect(await rejectedProjectSet()).toContain("Refusing to write project settings");
		expect(fs.existsSync(path.join(outside, "config.yml"))).toBe(false);
	});

	it("refuses to follow a symlinked .omp/config.yml out of the project", async () => {
		const outside = path.join(otherDir.path(), "victim.yml");
		await Bun.write(outside, "keep: me\n");
		fs.mkdirSync(path.join(projectDir.path(), ".omp"));
		fs.symlinkSync(outside, projectConfigFile());

		expect(await rejectedProjectSet()).toContain("Refusing to write project settings");
		expect(await Bun.file(outside).text()).toBe("keep: me\n");
	});

	it("refuses a .omp/config.yml linked to the global config", async () => {
		const globalConfig = path.join(agentDir.path(), "config.yml");
		await Bun.write(globalConfig, "theme:\n  dark: titanium\n");
		fs.mkdirSync(path.join(projectDir.path(), ".omp"));
		fs.symlinkSync(globalConfig, projectConfigFile());

		expect(await rejectedProjectSet()).toContain("Refusing to write project settings");
		expect(await Bun.file(globalConfig).text()).toBe("theme:\n  dark: titanium\n");
	});

	it("still writes through a symlink that stays inside the project", async () => {
		const real = path.join(projectDir.path(), "omp-settings");
		fs.mkdirSync(real);
		fs.symlinkSync(real, path.join(projectDir.path(), ".omp"), "dir");
		vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({
			action: "set",
			key: "compaction.enabled",
			value: "false",
			flags: { json: true, scope: "project", cwd: projectDir.path() },
		});

		expect(YAML.parse(await Bun.file(path.join(real, "config.yml")).text())).toEqual({
			compaction: { enabled: false },
		});
	});

	it("refuses the project scope in the home directory, where project settings are not read", async () => {
		const result = await runCli(
			["config", "set", "compaction.enabled", "false", "--scope", "project", "--cwd", projectDir.path()],
			{ env: { HOME: projectDir.path(), USERPROFILE: projectDir.path() } },
		);
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("home directory");
		expect(fs.existsSync(projectConfigFile())).toBe(false);
	});

	it("rejects --scope on get, path and init-xdg", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as typeof process.exit);

		await expect(
			runConfigCommand({ action: "get", key: "compaction.enabled", flags: { json: true, scope: "project" } }),
		).rejects.toThrow("process.exit");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});

describe("config list --scope", () => {
	it("lists only the keys the global file sets, path-scoped entries as written", async () => {
		await Bun.write(
			path.join(agentDir.path(), "config.yml"),
			[
				"enabledModels:",
				"  - anthropic/claude-sonnet-4-5",
				`  - path: ${projectDir.path()}`,
				"    models: [openai/gpt-5]",
				"disabledProviders:",
				"  - pathPrefix: /srv",
				"    providers: [ollama]",
				"compaction:",
				"  enabled: false",
				"hindsight:",
				"  apiToken: secret-token",
				"",
			].join("\n"),
		);
		await Bun.write(projectConfigFile(), "defaultThinkingLevel: high\n");

		const layer = await listJson({ args: ["--scope", "global", "--cwd", projectDir.path()] });

		expect(Object.keys(layer).toSorted()).toEqual(
			["compaction.enabled", "disabledProviders", "enabledModels", "hindsight.apiToken"].toSorted(),
		);
		expect(layer.enabledModels.value).toEqual([
			"anthropic/claude-sonnet-4-5",
			{ path: projectDir.path(), models: ["openai/gpt-5"] },
		]);
		expect(layer.disabledProviders.value).toEqual([{ pathPrefix: "/srv", providers: ["ollama"] }]);
		expect(layer["compaction.enabled"]).toMatchObject({ value: false, type: "boolean" });
		expect(layer["hindsight.apiToken"]).toMatchObject({ redacted: true });
		expect(layer["hindsight.apiToken"].value).toBeUndefined();
		for (const entry of Object.values(layer)) expect(entry).not.toHaveProperty("source");

		// The effective list resolves the path-scoped entry for --cwd instead.
		const effective = await listJson({ args: ["--cwd", projectDir.path()] });
		expect(effective.enabledModels.value).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
	});

	it("lists the project layer of --cwd", async () => {
		await Bun.write(path.join(agentDir.path(), "config.yml"), "compaction:\n  enabled: false\n");
		await Bun.write(projectConfigFile(), "defaultThinkingLevel: high\nenabledModels: [openai/gpt-5]\n");

		const layer = await listJson({ args: ["--scope", "project", "--cwd", projectDir.path()] });

		expect(layer).toEqual({
			defaultThinkingLevel: expect.objectContaining({ value: "high" }),
			enabledModels: expect.objectContaining({ value: ["openai/gpt-5"], type: "array" }),
		});
	});

	it("lists nothing for a layer that sets nothing", async () => {
		expect(await listJson({ args: ["--scope", "global"] })).toEqual({});
	});
});
