/**
 * Workspace trust: whether the working directory's own code and host-affecting config may run.
 * Every loader of project-supplied code (extensions, hooks, custom tools and commands, MCP, LSP and
 * DAP servers, SSH hosts) and the project settings layer consult it.
 */
import { register } from "./registry";
import type { Settings } from "./settings";

/**
 * `false` (set by a host's `--config` overlay, the runtime layer or the user's global config; a
 * project cannot set it) runs none of the project's own code and merges only an allowlist of
 * project settings.
 */
export const cfgWorkspaceTrusted = register({
	id: "workspace.trusted",
	type: "boolean",
	default: true,
	ui: {
		tab: "interaction",
		group: "Approvals",
		label: "Trust Workspace",
		description:
			"Run the project's own tools, commands, extensions, hooks, MCP/LSP/DAP servers and SSH hosts, and honor all of its settings. Off: none of them load, and project settings are limited to model, display and behaviour keys.",
	},
});

/** Whether `settings` trusts the working directory. */
export function isWorkspaceTrusted(settings: Settings): boolean {
	return cfgWorkspaceTrusted.get(settings) !== false;
}
