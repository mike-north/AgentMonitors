/**
 * Follow-up commands the CLI prints for a user to run next (`doctor`
 * remediations, the `monitor retry` hints). Each one must run verbatim when
 * pasted into a POSIX shell from the directory the printing command ran in:
 * arguments are quoted only when they need it, and a command carries
 * `--workspace` (and, for commands that read definitions, `--dir`) whenever its
 * own default would resolve to a different workspace or directory than the one
 * the printing command was given.
 *
 * Scope stays here; the shared core builder quotes arguments and keeps
 * monitor/retry IDs after an option terminator so option-looking IDs stay positional.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { _monitorCommandLine, shellArg } from '@agentmonitors/core';

export { _monitorCommandLine, shellSingleQuote } from '@agentmonitors/core';

/**
 * The workspace and monitor definitions a suggestion should read: the same
 * ones the printing command was pointed at.
 */
export interface SuggestionScope {
  /** Workspace the printing command was given (`--workspace` or the cwd). */
  workspacePath: string;
  /** Monitor definitions directory the printing command read, when it read one. */
  monitorsDir: string;
}

/** Path equality that tolerates symlinked spellings (e.g. macOS /tmp vs /private/tmp). */
function samePath(a: string, b: string): boolean {
  // Resolve symlinks through the nearest existing ancestor so not-yet-created
  // directories still compare equal.
  const canonical = (value: string): string => {
    const resolved = path.resolve(value);
    try {
      return realpathSync(resolved);
    } catch {
      const parent = path.dirname(resolved);
      return parent === resolved
        ? resolved
        : path.join(canonical(parent), path.basename(resolved));
    }
  };
  return canonical(a) === canonical(b);
}

/**
 * Raw `--workspace <path>` arguments when the workspace is not the current
 * directory, which every workspace-scoped command defaults to. Quoting belongs
 * to the command builder so every value is escaped exactly once.
 *
 * Workspace keys are the `path.resolve()` spelling and commands default to
 * `process.cwd()` (already a real path), so a symlinked spelling is a
 * different workspace and must be carried.
 */
export function workspaceFlags(workspacePath: string): string[] {
  return path.resolve(workspacePath) === path.resolve(process.cwd())
    ? []
    : ['--workspace', workspacePath];
}

/**
 * `--workspace` as {@link workspaceFlags}, plus `--dir <path>` when the
 * definitions are not at the `.claude/monitors` a command reads by default
 * (relative to the cwd). `--dir` is only read as files, so realpath equality
 * is enough.
 */
function scopeFlags(scope: SuggestionScope): string[] {
  const flags = workspaceFlags(scope.workspacePath);
  if (!samePath(scope.monitorsDir, '.claude/monitors')) {
    flags.push('--dir', scope.monitorsDir);
  }
  return flags;
}

/** `monitor explain <id>` reading the same workspace and definitions. */
export function explainCommand(scope: SuggestionScope, id: string): string {
  return _monitorCommandLine(['explain'], scopeFlags(scope), [id]);
}

/**
 * `monitor history <id>` scoped like {@link explainCommand}. History scopes by
 * `--workspace` only (it has no `--dir`), so only that flag is carried.
 */
export function historyCommand(
  scope: Pick<SuggestionScope, 'workspacePath'>,
  id: string,
): string {
  return _monitorCommandLine(['history'], workspaceFlags(scope.workspacePath), [
    id,
  ]);
}

/**
 * `doctor` reading the same workspace and definitions. Unlike `monitor
 * explain`, doctor defaults `--dir` to the workspace's own definitions
 * ({@link workspaceMonitorsDir}), so `--dir` is carried only when the
 * definitions are elsewhere.
 */
export function doctorCommandLine(scope: SuggestionScope): string {
  const flags = workspaceFlags(scope.workspacePath);
  if (!samePath(scope.monitorsDir, workspaceMonitorsDir(scope.workspacePath))) {
    flags.push('--dir', scope.monitorsDir);
  }
  return ['agentmonitors', 'doctor', ...flags].map(shellArg).join(' ');
}

/**
 * Where a workspace's monitor definitions live when nothing else names them:
 * the workspace's own `.claude/monitors`, which `doctor` and session-booted
 * daemons read by default. Used by commands that are scoped by workspace but
 * take no `--dir` of their own.
 */
export function workspaceMonitorsDir(workspacePath: string): string {
  return path.join(path.resolve(workspacePath), '.claude', 'monitors');
}
