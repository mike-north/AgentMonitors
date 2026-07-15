import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PRIVATE_FILE_MODE,
  restrictExistingPathMode,
} from '@agentmonitors/core';

export interface LocalState {
  enabled: boolean;
  socket?: string;
  db?: string;
  reapAfterMs?: number;
}

const DEFAULT_REAP_AFTER_MS = 5 * 60 * 1000;

function filePath(workspacePath: string): string {
  return path.join(workspacePath, '.claude', 'agentmonitors.local.md');
}

/**
 * Parse a minimal YAML frontmatter block (scalar values only: boolean, number,
 * string). Returns the parsed key/value pairs or null if the content doesn't
 * start with a valid `---\n...\n---` block.
 *
 * We intentionally avoid depending on gray-matter in the CLI package; the
 * `.local.md` format only ever contains simple scalars written by writeLocalState.
 */
function parseFrontmatter(raw: string): Record<string, unknown> | null {
  const lines = raw.split('\n');
  if (lines[0]?.trimEnd() !== '---') return null;
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (closeIdx === -1) return null;
  const data: Record<string, unknown> = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i] ?? '';
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();
    if (rawVal === 'true') {
      data[key] = true;
    } else if (rawVal === 'false') {
      data[key] = false;
    } else if (rawVal !== '' && !isNaN(Number(rawVal))) {
      data[key] = Number(rawVal);
    } else {
      data[key] = rawVal;
    }
  }
  return data;
}

/** Read the per-project coordination file. Absent/unparseable → disabled (quick-exit). */
export function readLocalState(workspacePath: string): LocalState {
  let raw: string;
  try {
    raw = readFileSync(filePath(workspacePath), 'utf-8');
  } catch {
    return { enabled: false };
  }
  let data: Record<string, unknown> | null;
  try {
    data = parseFrontmatter(raw);
  } catch {
    return { enabled: false };
  }
  if (data === null) return { enabled: false };
  const reap = data['reap-after-ms'];
  return {
    enabled: data['enabled'] === true,
    ...(typeof data['socket'] === 'string' ? { socket: data['socket'] } : {}),
    ...(typeof data['db'] === 'string' ? { db: data['db'] } : {}),
    reapAfterMs: typeof reap === 'number' ? reap : DEFAULT_REAP_AFTER_MS,
  };
}

/** Write the coordination file (creates `.claude/`). Frontmatter only. */
export function writeLocalState(
  workspacePath: string,
  state: LocalState,
): void {
  const target = filePath(workspacePath);
  // `.claude/` belongs to the host tool, so we do not force its mode; only the
  // coordination file we own is made owner-only (issue #292). It records the
  // per-workspace socket/db paths — not a secret, but part of the local trust
  // boundary.
  mkdirSync(path.dirname(target), { recursive: true });
  const lines = [
    '---',
    `enabled: ${String(state.enabled)}`,
    ...(state.socket ? [`socket: ${state.socket}`] : []),
    ...(state.db ? [`db: ${state.db}`] : []),
    `reap-after-ms: ${String(state.reapAfterMs ?? DEFAULT_REAP_AFTER_MS)}`,
    '---',
    '',
    '> Local AgentMon coordination state. Gitignored; safe to delete (it is regenerated).',
    '',
  ];
  writeFileSync(target, lines.join('\n'), {
    encoding: 'utf-8',
    mode: PRIVATE_FILE_MODE,
  });
  // `.claude/` belongs to the host tool, so only tighten the file we own; a
  // stale looser file left by an earlier version is re-tightened here (the
  // `writeFileSync` mode above only applies when it *creates* the file).
  restrictExistingPathMode(target, PRIVATE_FILE_MODE);
}
