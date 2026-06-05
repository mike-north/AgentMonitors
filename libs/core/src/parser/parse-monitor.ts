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
  // A folder monitor is `<id>/MONITOR.md` (id = parent dir). A flat monitor is
  // `<id>.md` directly in the monitors dir (id = filename without extension).
  // `path.extname` returns '' for extension-less names AND for bare dotfiles like
  // `.md`, so guard both: empty stem and dotfile stems (e.g. `.md` -> stem `.md`).
  const base = path.basename(filePath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base; // 'noext' -> 'noext', 'foo.bar.md' -> 'foo.bar'
  const id =
    base === 'MONITOR.md' ? path.basename(path.dirname(filePath)) : stem;

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
