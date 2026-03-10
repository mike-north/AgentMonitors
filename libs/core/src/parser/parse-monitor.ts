import matter from 'gray-matter';
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
  const dirName = path.basename(path.dirname(filePath));

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
      id: dirName,
      frontmatter: result.data,
      instructions: parsed.content.trim(),
      filePath,
    },
  };
}
