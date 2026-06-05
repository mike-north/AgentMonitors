import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { globSync } from 'glob';
import type { ParseError, ParseOutcome, ParseResult } from './parse-monitor.js';
import { parseMonitor } from './parse-monitor.js';

/**
 * A folder-derived monitor id that more than one parsed `MONITOR.md` resolves to.
 *
 * Duplicate ids are a correctness hazard, not a cosmetic one: runtime state is keyed
 * by `monitorId`, so two monitors sharing an id would alias each other's persisted
 * source and notify state (SP2).
 */
export interface DuplicateMonitorId {
  /** The colliding monitor id (a parent-directory basename). */
  id: string;
  /** Absolute paths of the `MONITOR.md` files that derive this id (at least two). */
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
  // Folder monitors live at `<id>/MONITOR.md` (any depth). Flat monitors are
  // `<id>.md` files directly in the monitors dir; markdown assets nested inside a
  // folder monitor are intentionally NOT discovered (only depth-1 `*.md`, minus
  // any stray MONITOR.md that the folder glob already covers).
  const folderMatches = globSync('**/MONITOR.md', {
    cwd: baseDir,
    absolute: true,
  });
  const flatMatches = globSync('*.md', {
    cwd: baseDir,
    absolute: true,
  }).filter((filePath) => path.basename(filePath) !== 'MONITOR.md');
  const matches = [...folderMatches, ...flatMatches];

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

  // Group parsed monitors by their folder-derived id; any id claimed by more than
  // one file is a collision (SP2). Insertion order is preserved for determinism.
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
