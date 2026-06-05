import matter from 'gray-matter';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { monitorFrontmatterSchema } from '../schema/monitor-schema.js';
import type { MonitorDefinition } from '../schema/types.js';

export interface ParseResult {
  ok: true;
  monitor: MonitorDefinition;
}

export interface ParseError {
  ok: false;
  filePath: string;
  error: string;
}

export type ParseOutcome = ParseResult | ParseError;

/**
 * Parse a MONITOR.md file from its raw content.
 *
 * @param content - Raw file content (frontmatter + body)
 * @param filePath - Absolute path to the MONITOR.md file
 */
export function parseMonitor(content: string, filePath: string): ParseOutcome {
  // Folder monitor: `<id>/MONITOR.md` (id = parent dir). Flat monitor: `<id>.md`
  // (id = path.parse stem). Guard empty/dot-prefixed ids (e.g. `.md`, `.foo.md`).
  const base = path.basename(filePath);
  const id =
    base === 'MONITOR.md'
      ? path.basename(path.dirname(filePath))
      : path.parse(filePath).name;

  if (!id || id.startsWith('.')) {
    return {
      ok: false,
      filePath,
      error: 'Could not derive a monitor id from the file path',
    };
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch {
    return { ok: false, filePath, error: 'Failed to parse YAML frontmatter' };
  }

  const result = monitorFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return { ok: false, filePath, error: messages };
  }

  return {
    ok: true,
    monitor: {
      id,
      displayName: result.data.name ?? id,
      frontmatter: result.data,
      instructions: parsed.content.trim(),
      filePath,
    },
  };
}

/**
 * Parse a MONITOR.md file from its path on disk.
 *
 * @param filePath - Absolute path to the MONITOR.md file
 */
export function parseMonitorFile(filePath: string): ParseOutcome {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return parseMonitor(content, filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, filePath, error: `Failed to read file: ${message}` };
  }
}
