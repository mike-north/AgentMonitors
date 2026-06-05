import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { globSync } from 'glob';
import type { ParseError, ParseOutcome, ParseResult } from './parse-monitor.js';
import { parseMonitor } from './parse-monitor.js';

/**
 * A monitor id derived from a directory name or a flat filename that more than one
 * parsed monitor resolves to.
 *
 * Duplicate ids are a correctness hazard, not a cosmetic one: runtime state is keyed
 * by `monitorId`, so two monitors sharing an id would alias each other's persisted
 * source and notify state (SP2).
 */
export interface DuplicateMonitorId {
  /** The colliding monitor id (derived from a directory name or a flat filename). */
  id: string;
  /** Absolute paths of the monitor files that derive this id (at least two). */
  filePaths: string[];
}

export interface ScanResult {
  monitors: ParseResult[];
  errors: ParseError[];
  /**
   * Monitor ids that more than one successfully-parsed monitor derives. Empty when
   * all ids are unique. Callers MUST treat a non-empty list as an error (SP2); the
   * runtime refuses to tick and the CLI surfaces it.
   */
  duplicateIds: DuplicateMonitorId[];
}

/**
 * Scan a directory for MONITOR.md files, parse each, and return results + errors.
 *
 * @param baseDir - Directory to scan (e.g., `~/.claude/monitors` or `<project>/.claude/monitors`)
 */
export async function scanMonitors(baseDir: string): Promise<ScanResult> {
  // Folder monitors live at `<id>/MONITOR.md` (at least one directory deep — the
  // folder name is the id). A bare `<monitors-root>/MONITOR.md` at depth-0 is NOT
  // a valid monitor (it would derive its id from the monitors-root name), so it is
  // excluded. Flat monitors are `<id>.md` files directly in the monitors dir;
  // markdown assets nested inside a folder monitor are intentionally NOT discovered
  // (only depth-1 `*.md`, minus any stray MONITOR.md the flat glob would pick up).
  const resolvedBase = path.resolve(baseDir);
  const folderMatches = globSync('**/MONITOR.md', {
    cwd: baseDir,
    absolute: true,
  }).filter(
    (filePath) => path.dirname(path.resolve(filePath)) !== resolvedBase,
  );
  // Dot-prefixed files and directories (e.g. `.hidden.md`) are intentionally
  // ignored — `*.md` does not match dotfiles under glob default options.
  const flatMatches = globSync('*.md', {
    cwd: baseDir,
    absolute: true,
  }).filter((filePath) => path.basename(filePath) !== 'MONITOR.md');
  // Sort for deterministic output regardless of filesystem order.
  const matches = [...folderMatches, ...flatMatches].sort();

  const outcomes: ParseOutcome[] = await Promise.all(
    matches.map(async (filePath) => {
      const absolutePath = path.resolve(filePath);
      try {
        const content = await readFile(absolutePath, 'utf-8');
        return parseMonitor(content, absolutePath);
      } catch {
        return {
          ok: false as const,
          filePath: absolutePath,
          error: 'Failed to read file',
        };
      }
    }),
  );

  const monitors: ParseResult[] = [];
  const errors: ParseError[] = [];

  for (const outcome of outcomes) {
    if (outcome.ok) {
      monitors.push(outcome);
    } else {
      errors.push(outcome);
    }
  }

  // Group parsed monitors by their id; any id claimed by more than one file is a
  // collision (SP2). The sorted input order is preserved by Map insertion order.
  const filePathsById = new Map<string, string[]>();
  for (const { monitor } of monitors) {
    const existing = filePathsById.get(monitor.id);
    if (existing) {
      existing.push(monitor.filePath);
    } else {
      filePathsById.set(monitor.id, [monitor.filePath]);
    }
  }

  const duplicateIds: DuplicateMonitorId[] = [];
  for (const [id, filePaths] of filePathsById) {
    if (filePaths.length > 1) {
      duplicateIds.push({ id, filePaths });
    }
  }

  return { monitors, errors, duplicateIds };
}
