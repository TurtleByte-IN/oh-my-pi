/**
 * Config directories of every discovery source. Kept free of heavy imports: the settings layer and
 * the approval check (`config/agent-config-paths.ts`) read it to protect what providers load.
 */
import { CONFIG_DIR_NAME, getConfigDirName } from "@oh-my-pi/pi-utils";

/**
 * Standard paths for each config source.
 */
export const SOURCE_PATHS = {
	native: {
		get userBase() {
			return getConfigDirName();
		},
		get userAgent() {
			return `${getConfigDirName()}/agent`;
		},
		projectDir: CONFIG_DIR_NAME,
	},
	claude: {
		userBase: ".claude",
		userAgent: ".claude",
		projectDir: ".claude",
	},
	codex: {
		userBase: ".codex",
		userAgent: ".codex",
		projectDir: ".codex",
	},
	gemini: {
		userBase: ".gemini",
		userAgent: ".gemini",
		projectDir: ".gemini",
	},
	opencode: {
		userBase: ".config/opencode",
		userAgent: ".config/opencode",
		projectDir: ".opencode",
	},
	cursor: {
		userBase: ".cursor",
		userAgent: ".cursor",
		projectDir: ".cursor",
	},
	windsurf: {
		userBase: ".codeium/windsurf",
		userAgent: ".codeium/windsurf",
		projectDir: ".windsurf",
	},
	cline: {
		userBase: ".cline",
		userAgent: ".cline",
		projectDir: null, // Cline uses root-level .clinerules
	},
	github: {
		userBase: null,
		userAgent: null,
		projectDir: ".github",
	},
	vscode: {
		userBase: ".vscode",
		userAgent: ".vscode",
		projectDir: ".vscode",
	},
} as const;

export type SourceId = keyof typeof SOURCE_PATHS;
