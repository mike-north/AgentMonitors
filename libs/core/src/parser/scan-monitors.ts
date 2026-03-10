import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { globSync } from 'glob';
import type { ParseError, ParseOutcome, ParseResult } from './parse-monitor.js';
import { parseMonitor } from './parse-monitor.js';

export interface ScanResult {
  monitors: ParseResult[];
  errors: ParseError[];
}

/**
 * Scan a directory for MONITOR.md files, parse each, and return results + errors.
 *
 * @param baseDir - Directory to scan (e.g., `~/.claude/monitors` or `<project>/.claude/monitors`)
 */
export async function scanMonitors(baseDir: string): Promise<ScanResult> {
  const pattern = '**/MONITOR.md';
  const matches = globSync(pattern, { cwd: baseDir, absolute: true });

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

  return { monitors, errors };
}
