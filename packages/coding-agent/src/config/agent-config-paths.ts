/**
 * Files whose contents widen what the agent may do or run code: approval policies, MCP, LSP, DAP and
 * SSH configs, extensions, hooks, custom tools and commands, plugins, git hooks. A tool call that
 * writes one is never approved by the approval mode alone (see `tools/approval.ts`), so an
 * auto-approved edit cannot escalate itself to unasked commands.
 *
 * Matching fails closed: the target is checked both as written and with symlinks resolved, segment
 * names are compared case-folded (default APFS and NTFS are case-insensitive) with the trailing dots
 * and spaces Windows drops removed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SOURCE_PATHS } from "../discovery/source-paths";

/** `--config` / `PI_CONFIG_FILES` overlays the running process loads, as folded `/`-joined paths. */
const configFiles = new Set<string>();

/**
 * Config directories, as consecutive folded segments: every discovery source's project and user
 * directory (one table, {@link SOURCE_PATHS}), plus the legacy `.pi`. Anything below one is protected.
 */
function protectedDirs(): string[][] {
	const dirs: string[][] = [[".pi"]];
	for (const source of Object.values(SOURCE_PATHS)) {
		for (const dir of [source.projectDir, source.userBase]) {
			if (dir) dirs.push(dir.split("/").map(foldSegment));
		}
	}
	return dirs;
}

/** Git runs these itself: hooks, and `config` (`core.hooksPath`, `core.fsmonitor`, aliases). */
const GIT_PROTECTED: readonly string[] = ["hooks", "config"];

/** Config file base names that name programs to spawn or hosts to reach (`lsp.json`, `.lsp.yml`, …). */
const SPAWN_CONFIG_BASES: readonly string[] = ["lsp", "dap", "ssh"];
const SPAWN_CONFIG_EXTENSIONS: readonly string[] = [".json", ".yaml", ".yml"];

/** Other config files loaded from the project root or `$HOME`. */
const PROTECTED_FILES: ReadonlySet<string> = new Set([
	"mcp.json",
	".mcp.json",
	"opencode.json",
	"opencode.jsonc",
	".claude.json",
	...SPAWN_CONFIG_BASES.flatMap(base => SPAWN_CONFIG_EXTENSIONS.flatMap(ext => [`${base}${ext}`, `.${base}${ext}`])),
]);

/** Case-folds `segment` and drops the trailing dots and spaces Windows ignores. */
function foldSegment(segment: string): string {
	return segment.toLowerCase().replace(/[. ]+$/, "") || segment;
}

/** `resolved` with the deepest existing ancestor's symlinks resolved, or `undefined` when nothing resolves. */
function realPathOfDeepestAncestor(resolved: string): string | undefined {
	const rest: string[] = [];
	let current = resolved;
	for (;;) {
		try {
			return path.join(fs.realpathSync.native(current), ...rest.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			rest.push(path.basename(current));
			current = parent;
		}
	}
}

/** Folded segment lists of `target` as written and with symlinks resolved. */
function candidateSegments(target: string, cwd: string | undefined): string[][] {
	const resolved = cwd === undefined ? path.resolve(target) : path.resolve(cwd, target);
	const forms = [resolved];
	const real = realPathOfDeepestAncestor(resolved);
	if (real !== undefined && real !== resolved) forms.push(real);
	return forms.map(form =>
		form
			.split(/[\\/]+/)
			.filter(segment => segment.length > 0)
			.map(foldSegment),
	);
}

/** Records overlay files the settings layer loads; their paths are not otherwise recognizable. */
export function registerAgentConfigFiles(files: Iterable<string>): void {
	for (const file of files) {
		for (const segments of candidateSegments(file, undefined)) configFiles.add(segments.join("/"));
	}
}

function containsRun(segments: readonly string[], run: readonly string[]): boolean {
	for (let i = 0; i + run.length <= segments.length; i++) {
		if (run.every((segment, j) => segments[i + j] === segment)) return true;
	}
	return false;
}

function isProtectedSegments(segments: readonly string[], dirs: readonly string[][]): boolean {
	// A directory is protected only as a parent: `foo/.codex` itself (being created) counts too.
	if (dirs.some(dir => containsRun(segments, dir))) return true;
	const gitIndex = segments.lastIndexOf(".git");
	if (gitIndex !== -1 && GIT_PROTECTED.includes(segments[gitIndex + 1] ?? "")) return true;
	return PROTECTED_FILES.has(segments.at(-1) ?? "");
}

/**
 * Whether `target` (a file or folder; relative to `cwd`, default `process.cwd()`) is agent
 * configuration: under any discovery source's config directory (`.omp`, `.pi`, `.claude`, `.codex`,
 * `.gemini`, `.opencode`, `.cursor`, …, project or user), `.git/hooks` or `.git/config`, an MCP,
 * LSP, DAP, SSH or opencode config file, or a loaded `--config` overlay.
 */
export function isAgentConfigPath(target: string, cwd?: string): boolean {
	const forms = candidateSegments(target, cwd);
	if (forms.some(segments => configFiles.has(segments.join("/")))) return true;
	const dirs = protectedDirs();
	return forms.some(segments => isProtectedSegments(segments, dirs));
}
