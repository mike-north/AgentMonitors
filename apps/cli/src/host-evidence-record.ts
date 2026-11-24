/**
 * Where a Claude Code session's transcript lives, as its own hooks reported it
 * (006 §4.5.2).
 *
 * The channel server is an MCP subprocess: the host never tells it the
 * session's `transcript_path`. Hooks do receive it, on every invocation, in
 * their stdin payload. `session start` (SessionStart) and `hook deliver`
 * (UserPromptSubmit) therefore record it here, keyed by host session id, and
 * `channel serve` reads it back to find the transcript it confirms pushes
 * against. A later prompt overwrites the record, so a `/clear` or resume that
 * moves the session to a new transcript is picked up on the next prompt.
 *
 * The record holds a path and a timestamp, never transcript content. It is
 * CLI-owned, private to the user (0700 directory, atomic writes), and kept
 * apart from the transport heartbeat registry so neither reader ever has to
 * tell the two record kinds apart.
 */

import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  isClaudeTranscriptPathForSession,
  writePrivateFileAtomic,
} from '@agentmonitors/core';
import { sanitizeKey } from './transport-heartbeat.js';
import { resolveDataRoot } from './workspace-paths.js';

/** Bumped only on an incompatible field change. */
const HOST_EVIDENCE_SCHEMA_VERSION = 1;

/**
 * How long a record is kept after its session last reported it, measured from
 * the record's `observedAt`. Records are bounded by sessions (each session
 * overwrites its own), so this only reaps sessions that stopped reporting long
 * ago.
 */
const HOST_EVIDENCE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * An unchanged report rewrites the record only once its `observedAt` is at
 * least this old. That keeps a session's record young for as long as its hooks
 * keep running, without a write on every prompt.
 */
const HOST_EVIDENCE_REFRESH_MS = 60 * 60 * 1000;

/** One session's transcript location, as its hooks reported it. */
export interface HostTranscriptRecord {
  schemaVersion: number;
  hostSessionId: string;
  /** Absolute path of the session's transcript, from the hook payload. */
  transcriptPath: string;
  /**
   * When a hook last reported this path (ISO 8601), to within
   * {@link HOST_EVIDENCE_REFRESH_MS}. Retention is measured from here.
   */
  observedAt: string;
}

/** The directory host-evidence records live in. */
export function hostEvidenceDir(): string {
  return path.join(resolveDataRoot(), 'agentmonitors', 'host-evidence');
}

function recordPath(hostSessionId: string): string {
  return path.join(
    hostEvidenceDir(),
    `claude-transcript-${sanitizeKey(hostSessionId)}.json`,
  );
}

function isHostTranscriptRecord(value: unknown): value is HostTranscriptRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record['schemaVersion'] === HOST_EVIDENCE_SCHEMA_VERSION &&
    typeof record['hostSessionId'] === 'string' &&
    typeof record['transcriptPath'] === 'string' &&
    typeof record['observedAt'] === 'string'
  );
}

/**
 * Record the transcript path a hook reported for its session. Only a path
 * that names this session's own transcript is recorded; anything else is
 * ignored (the channel route then stays unproven). Skips the write when the
 * stored record already says the same thing and was refreshed recently.
 *
 * **Never throws**: this runs inside host hooks, where a failure must not
 * disturb the user's session.
 */
export function recordHostTranscriptPath(
  hostSessionId: string,
  transcriptPath: string | undefined,
  now: Date = new Date(),
): void {
  try {
    if (
      transcriptPath === undefined ||
      !isClaudeTranscriptPathForSession(transcriptPath, hostSessionId)
    ) {
      return;
    }
    const target = recordPath(hostSessionId);
    const existing = readRecordAt(target);
    if (
      existing?.hostSessionId === hostSessionId &&
      existing.transcriptPath === transcriptPath &&
      now.getTime() - Date.parse(existing.observedAt) < HOST_EVIDENCE_REFRESH_MS
    ) {
      return;
    }
    const record: HostTranscriptRecord = {
      schemaVersion: HOST_EVIDENCE_SCHEMA_VERSION,
      hostSessionId,
      transcriptPath,
      observedAt: now.toISOString(),
    };
    writePrivateFileAtomic(target, `${JSON.stringify(record, null, 2)}\n`, {
      tempSuffix: `.${String(process.pid)}`,
    });
    reapOldRecords(now);
  } catch {
    // Best-effort: no record simply means no confirmation source.
  }
}

function readRecordAt(target: string): HostTranscriptRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf-8'));
    return isHostTranscriptRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The transcript path recorded for a host session, or `undefined` when there
 * is none or it fails validation. Never throws.
 */
export function readHostTranscriptPath(
  hostSessionId: string,
): string | undefined {
  const record = readRecordAt(recordPath(hostSessionId));
  if (record?.hostSessionId !== hostSessionId) return undefined;
  return isClaudeTranscriptPathForSession(record.transcriptPath, hostSessionId)
    ? record.transcriptPath
    : undefined;
}

function reapOldRecords(now: Date): void {
  let names: string[];
  try {
    names = readdirSync(hostEvidenceDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('claude-transcript-') || !name.endsWith('.json')) {
      continue;
    }
    const filePath = path.join(hostEvidenceDir(), name);
    try {
      // Age from the last report the record carries; a record that cannot be
      // read (or carries no valid time) falls back to its file's mtime.
      const observed = Date.parse(readRecordAt(filePath)?.observedAt ?? '');
      const lastReported = Number.isNaN(observed)
        ? statSync(filePath).mtimeMs
        : observed;
      if (now.getTime() - lastReported > HOST_EVIDENCE_RETENTION_MS) {
        rmSync(filePath, { force: true });
      }
    } catch {
      continue;
    }
  }
}
