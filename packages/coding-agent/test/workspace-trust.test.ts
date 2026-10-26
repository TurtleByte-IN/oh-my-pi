import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isAgentConfigPath, registerAgentConfigFiles } from "@oh-my-pi/pi-coding-agent/config/agent-config-paths";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import { cfgBashPatterns } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { cfgToolsApproval, cfgWorkspaceTrusted } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { Snowflake } from "@oh-my-pi/pi-utils";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A project whose own config widens approvals and starts MCP servers, plus an Ompanel-style overlay. */
const workspace = (overlay: string) => {
	const root = path.join(os.tmpdir(), `workspace-trust-${Snowflake.next()}`);
	dirs.push(root);
	const project = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(
		path.join(project, ".omp", "config.yml"),
		[
			"tools:",
			"  approval:",
			"    bash: allow",
			"bash:",
			"  patterns:",
			"    - { match: '*', approval: allow }",
			"mcp:",
			"  enableProjectConfig: true",
			"workspace:",
			"  trusted: true",
			"",
		].join("\n"),
	);
	fs.writeFileSync(path.join(agentDir, "config.yml"), "tools:\n  approval:\n    edit: deny\n");
	const overlayPath = path.join(root, "overlay.yml");
	fs.writeFileSync(overlayPath, overlay);
	return Settings.loadIsolated({ cwd: project, agentDir, configFiles: [overlayPath] });
};

describe("workspace.trusted", () => {
	it("honors the project's approval policies and MCP servers in a trusted workspace", async () => {
		const settings = await workspace("{}\n");
		expect(cfgWorkspaceTrusted.get(settings)).toBe(true);
		expect(cfgToolsApproval.get(settings)).toEqual({ bash: "allow", edit: "deny" });
		expect(JSON.stringify(cfgBashPatterns.get(settings))).toBe(JSON.stringify([{ match: "*", approval: "allow" }]));
		expect(cfgMcpEnableProjectConfig.get(settings)).toBe(true);
	});

	it("drops them when a layer above the project says untrusted; the project cannot trust itself", async () => {
		const settings = await workspace("workspace:\n  trusted: false\nmcp:\n  enableProjectConfig: true\n");
		expect(cfgWorkspaceTrusted.get(settings)).toBe(false);
		// The user's own global policy stays; the project's allow rules are gone.
		expect(cfgToolsApproval.get(settings)).toEqual({ edit: "deny" });
		expect(cfgBashPatterns.get(settings)).toEqual([]);
		// No project MCP servers, whatever any layer says.
		expect(cfgMcpEnableProjectConfig.get(settings)).toBe(false);
	});
});

describe("writes to agent configuration", () => {
	const write = {
		name: "write",
		approval: { tier: "write" as const },
		approvalCacheTargets: (args: unknown) =>
			args !== null && typeof args === "object" && "path" in args && typeof args.path === "string"
				? [args.path]
				: [],
	};

	it("recognizes project and user agent config, MCP and Claude settings, and loaded overlays", () => {
		expect(isAgentConfigPath("/repo/.omp/config.yml")).toBe(true);
		expect(isAgentConfigPath("/home/u/.omp/agent/config.yml")).toBe(true);
		expect(isAgentConfigPath("/repo/.omp/extensions/x.ts")).toBe(true);
		expect(isAgentConfigPath("/repo/.mcp.json")).toBe(true);
		expect(isAgentConfigPath("/repo/.claude/settings.local.json")).toBe(true);
		expect(isAgentConfigPath("/repo/src/app.ts")).toBe(false);
		const overlay = path.join(os.tmpdir(), `ompanel-overlay-${Snowflake.next()}.yml`);
		expect(isAgentConfigPath(overlay)).toBe(false);
		registerAgentConfigFiles([overlay]);
		expect(isAgentConfigPath(overlay)).toBe(true);
	});

	it("always asks outside yolo, even when the mode or a user allow would approve the write", () => {
		const config = { path: "/repo/.omp/config.yml" };
		const source = { path: "/repo/src/app.ts" };
		expect(resolveApproval(write, source, "write").policy).toBe("allow");
		const asked = resolveApproval(write, config, "write", { write: "allow" });
		expect(asked.policy).toBe("prompt");
		expect(asked.override).toBe(true);
		expect(resolveApproval(write, config, "always-ask").policy).toBe("prompt");
		// Full access stays unasked.
		expect(resolveApproval(write, config, "yolo").policy).toBe("allow");
		// A deny still denies.
		expect(resolveApproval(write, config, "write", { write: "deny" }).policy).toBe("deny");
	});
});
