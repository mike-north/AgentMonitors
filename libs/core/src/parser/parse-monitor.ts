/** Read and validate bounded monitor definitions while preserving file-local diagnostics. */
import path from 'node:path';
import matter from 'gray-matter';
import { MAX_MONITOR_BYTES } from '../schema/input-limits.js';
import { monitorFrontmatterSchema } from '../schema/monitor-schema.js';
import type { MonitorDefinition } from '../schema/types.js';
import { readMonitorFileSync } from './read-monitor-file.js';

export interface ParseResult {
  ok: true;
  monitor: MonitorDefinition;
}

export interface ParseError {
  ok: false;
  filePath: string;
  error: string;
  /** Machine-readable admission failure; ordinary parse errors omit it. */
  code?: 'INPUT_LIMIT_EXCEEDED';
}

export type ParseOutcome = ParseResult | ParseError;

/**
 * Parse a MONITOR.md file from its raw content.
 *
 * @param content - Raw file content (frontmatter + body)
 * @param filePath - Absolute path to the MONITOR.md file
 */
export function parseMonitor(content: string, filePath: string): ParseOutcome {
  if (Buffer.byteLength(content, 'utf8') > MAX_MONITOR_BYTES) {
    return monitorByteLimitError(filePath);
  }
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
    return {
      ok: false,
      filePath,
      error: messages,
      ...(result.error.issues.some(
        (issue) =>
          issue.code === 'custom' && issue.params?.['inputLimit'] === true,
      )
        ? { code: 'INPUT_LIMIT_EXCEEDED' as const }
        : {}),
    };
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
    const content = readMonitorFileSync(filePath);
    return content === undefined
      ? monitorByteLimitError(filePath)
      : parseMonitor(content, filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, filePath, error: `Failed to read file: ${message}` };
  }
}

/** A shared admission diagnostic for direct file parsing and discovery. @internal */
export function monitorByteLimitError(filePath: string): ParseError {
  return {
    ok: false,
    filePath,
    code: 'INPUT_LIMIT_EXCEEDED',
    error: `INPUT_LIMIT_EXCEEDED: monitor must be at most ${String(MAX_MONITOR_BYTES)} UTF-8 bytes`,
  };
}
