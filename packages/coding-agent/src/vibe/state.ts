/** Vibe mode session-level state, mirroring {@link ../plan-mode/state.ts}. */
export interface VibeModeState {
	enabled: boolean;
}

/**
 * Reads a tool-name snapshot out of a persisted `mode_change` payload. Session
 * files are user-editable and survive across versions, so anything that is not
 * a plain array of strings is treated as absent rather than trusted.
 */
export function readPersistedToolNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (!value.every(name => typeof name === "string")) return undefined;
	return value as string[];
}
