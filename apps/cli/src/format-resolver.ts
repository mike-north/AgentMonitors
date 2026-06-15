/**
 * Format auto-detection for structured-output CLI commands.
 *
 * When `--format` is not explicitly passed, we detect whether the command is
 * being driven by an agent or an interactive human and pick the appropriate
 * rendering:
 *
 *   - **Agent** (`isAgenticTui()` → `true`): TOON — token-efficient, lossless
 *     round-trips, optimised for LLM context windows.
 *   - **Human** (interactive terminal): text — human-readable tables, one row
 *     per record, the output authors see at a prompt.
 *
 * An explicit `--format toon|json|text` always wins and bypasses detection.
 *
 * Detection is powered by `is-agentic-tui`, which keys off well-known
 * environment variables set by Claude Code, Cursor, Gemini CLI, and other
 * agentic TUIs (e.g. `CLAUDECODE=1`, `CURSOR_AGENT=1`, `GEMINI_CLI=1`).
 * Because the library caches its result, call `clearAgentDetectionCache()`
 * between tests that manipulate those env vars.
 *
 * @see https://github.com/mike-north/is-agentic-tui
 * @see https://toonformat.dev/
 */
import { isAgenticTui, clearCache } from 'is-agentic-tui';

/** The three concrete output formats a command can render. */
export type ResolvedFormat = 'toon' | 'json' | 'text';

/**
 * Resolve the effective output format for a structured-output command.
 *
 * @param explicit - The value of `--format` if the flag was passed; `undefined`
 *   if the flag was omitted (Commander returns `undefined` when no `.default()`
 *   is set and the flag is absent).
 * @returns The concrete format to use for rendering.
 */
export function resolveFormat(explicit: string | undefined): ResolvedFormat {
  if (explicit === 'json' || explicit === 'toon' || explicit === 'text') {
    return explicit;
  }
  // Auto-detect: agent → toon, human → text.
  return isAgenticTui({ force: true }) ? 'toon' : 'text';
}

/**
 * Clear the `is-agentic-tui` detection cache.
 *
 * Call this in `beforeEach`/`afterEach` in tests that manipulate the agentic
 * env vars (`CLAUDECODE`, `CURSOR_AGENT`, `GEMINI_CLI`, `AIDER`, etc.) so that
 * each test starts from a clean detection state rather than a cached value from
 * a previous test's environment.
 */
export { clearCache as clearAgentDetectionCache };
