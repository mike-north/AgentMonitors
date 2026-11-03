/** Read and validate bounded monitor definitions while preserving file-local diagnostics. */
import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { MAX_MONITOR_BYTES } from '../schema/input-limits.js';
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
    // Read at most one byte beyond admission, even if the file grows after
    // opening. A stat-then-read check alone would leave an allocation race.
    const fd = openSync(filePath, 'r');
    try {
      const bytes = Buffer.alloc(MAX_MONITOR_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (count === 0) {
          break;
        }
        size += count;
      }
      if (size > MAX_MONITOR_BYTES) {
        return monitorByteLimitError(filePath);
      }
      return parseMonitor(bytes.subarray(0, size).toString('utf8'), filePath);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, filePath, error: `Failed to read file: ${message}` };
  }
}

/** A single bounded diagnostic replaces potentially unbounded parser output. */
function monitorByteLimitError(filePath: string): ParseError {
  return {
    ok: false,
    filePath,
    code: 'INPUT_LIMIT_EXCEEDED',
    error: `INPUT_LIMIT_EXCEEDED: monitor must be at most ${String(MAX_MONITOR_BYTES)} UTF-8 bytes`,
  };
}
