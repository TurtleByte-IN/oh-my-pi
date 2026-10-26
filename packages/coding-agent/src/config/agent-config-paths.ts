/**
 * Files whose contents widen what the agent may do: approval policies, MCP servers, extensions,
 * hooks. A tool call that writes one is never approved by the approval mode alone (see
 * `tools/approval.ts`), so an auto-approved edit cannot escalate itself to unasked commands.
 */
import * as path from "node:path";

/** `--config` / `PI_CONFIG_FILES` overlays the running process loads. */
const configFiles = new Set<string>();

/** Records overlay files the settings layer loads; their paths are not otherwise recognizable. */
export function registerAgentConfigFiles(files: Iterable<string>): void {
	for (const file of files) configFiles.add(path.resolve(file));
}

/**
 * Whether `target` (a file or folder) is agent configuration: anything under an `.omp` or `.pi`
 * directory (project and user agent dirs), `.mcp.json` / `mcp.json`, `.claude/settings*.json`,
 * or a loaded `--config` overlay.
 */
export function isAgentConfigPath(target: string): boolean {
	const resolved = path.resolve(target);
	if (configFiles.has(resolved)) return true;
	const segments = resolved.split(/[\\/]+/).filter(segment => segment.length > 0);
	if (segments.includes(".omp") || segments.includes(".pi")) return true;
	const base = segments.at(-1) ?? "";
	if (base === ".mcp.json" || base === "mcp.json") return true;
	return segments.at(-2) === ".claude" && base.startsWith("settings");
}
