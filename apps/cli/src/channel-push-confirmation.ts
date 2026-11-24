/**
 * Host confirmation that a channel push reached the Claude Code session
 * (006 §4.5.2).
 *
 * A resolved `notification()` is not evidence: a host with no channel
 * listener drops the event and still reports success (006 §12.6). The channel
 * therefore commits a delivery only once the host's own record shows it
 * accepted the push — for Claude Code, the `enqueue` entry the host appends to
 * the session transcript, matched on the push's delivery id by the Claude
 * adapter's {@link scanClaudeTranscriptForChannelPush}.
 *
 * This module is the file-system half of that check, and is deliberately
 * narrow:
 *
 * - **Read-only.** The transcript is opened read-only, never created, and
 *   never through a symlink.
 * - **Only appended bytes.** The read offset is the file's size just before
 *   the push; nothing earlier is ever read.
 * - **Bounded.** At most {@link CHANNEL_CONFIRM_MAX_SCAN_BYTES} are scanned and
 *   the wait ends after {@link CHANNEL_CONFIRM_BOUND_MS}, well inside the
 *   delivery reservation's own ceiling, so an unconfirmed push is released
 *   while its rows are still leased.
 * - **Nothing kept.** Bytes are scanned and dropped; nothing from the
 *   transcript is stored, logged or returned beyond the boolean verdict.
 *
 * Any failure — no recorded path, a missing or replaced file, a read error, a
 * truncated file, the scan cap — is an unconfirmed push, never a confirmed
 * one. An unconfirmed push is released, and the hook path delivers (PP1).
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { scanClaudeTranscriptForChannelPush } from '@agentmonitors/core';
import { readHostTranscriptPath } from './host-evidence-record.js';

/**
 * How long a push waits for host confirmation. Claude Code records the
 * `enqueue` when the event arrives (observed `enqueue`→`dequeue` gaps are a
 * few milliseconds); the bound covers the host's write buffering with a wide
 * margin while staying far below `DEFAULT_DELIVERY_RESERVATION_TTL_MS` (30s).
 */
export const CHANNEL_CONFIRM_BOUND_MS = 5_000;

/** Interval between reads of the transcript's appended bytes while waiting. */
export const CHANNEL_CONFIRM_POLL_MS = 200;

/**
 * Upper bound on transcript bytes scanned for one push. A busy session can
 * append large tool results while the push is in flight; past this cap the
 * push is treated as unconfirmed rather than reading without limit.
 */
export const CHANNEL_CONFIRM_MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** One push's outstanding confirmation. */
export interface PendingChannelConfirmation {
  /** Resolves `true` only once the host's acceptance of this push is seen. */
  wait(): Promise<boolean>;
}

/**
 * Starts a confirmation for one push. Called just before the push, so the
 * evidence it waits for is only what the host writes afterwards. Returns
 * `undefined` when no usable evidence source exists for this session, in
 * which case the channel does not push at all.
 */
export interface ChannelPushConfirmer {
  begin(deliveryId: string): PendingChannelConfirmation | undefined;
}

/** Tuning and clock seams; production uses the module defaults. */
export interface TranscriptConfirmerOptions {
  boundMs?: number;
  pollMs?: number;
  maxScanBytes?: number;
  /** Resolves the transcript path for the session (defaults to the hook record). */
  resolveTranscriptPath?: (hostSessionId: string) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Read-only, never following a symlink, and never blocking: `O_NONBLOCK` makes
 * opening a FIFO swapped over the transcript return at once, so the `fstat`
 * check rejects it instead of the open waiting for a writer and stalling the
 * whole channel process. Where the platform lacks a flag, the `lstat` and
 * `fstat` checks stand alone.
 */
const OPEN_FLAGS =
  constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0) |
  (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0);

/** The transcript's current size, or `undefined` if it is not a regular file. */
function regularFileSize(transcriptPath: string): number | undefined {
  try {
    const stat = lstatSync(transcriptPath);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read up to `limit` bytes of `transcriptPath` starting at `offset`. Returns
 * `undefined` on any error, if the file is no longer a regular file, or if it
 * shrank below `offset` (truncated or replaced).
 */
function readAppended(
  transcriptPath: string,
  offset: number,
  limit: number,
): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, OPEN_FLAGS);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < offset) return undefined;
    const length = Math.min(stat.size - offset, limit);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a read-only descriptor cannot lose data.
      }
    }
  }
}

/**
 * The Claude Code confirmer: waits for the session transcript's `enqueue`
 * entry carrying the push's delivery id.
 */
export function createTranscriptConfirmer(
  hostSessionId: string,
  options: TranscriptConfirmerOptions = {},
): ChannelPushConfirmer {
  const boundMs = options.boundMs ?? CHANNEL_CONFIRM_BOUND_MS;
  const pollMs = options.pollMs ?? CHANNEL_CONFIRM_POLL_MS;
  const maxScanBytes = options.maxScanBytes ?? CHANNEL_CONFIRM_MAX_SCAN_BYTES;
  const resolvePath = options.resolveTranscriptPath ?? readHostTranscriptPath;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  return {
    begin(deliveryId) {
      const transcriptPath = resolvePath(hostSessionId);
      if (transcriptPath === undefined) return undefined;
      const startSize = regularFileSize(transcriptPath);
      if (startSize === undefined) return undefined;

      return {
        async wait() {
          const deadline = now() + boundMs;
          let offset = startSize;
          let scanned = 0;
          for (;;) {
            const appended = readAppended(
              transcriptPath,
              offset,
              maxScanBytes - scanned,
            );
            if (appended === undefined) return false;
            const result = scanClaudeTranscriptForChannelPush(appended, {
              deliveryId,
              hostSessionId,
            });
            if (result.confirmed) return true;
            offset += result.consumedBytes;
            scanned += result.consumedBytes;
            // A partial line that already fills the remaining budget can never
            // complete inside it.
            if (
              scanned >= maxScanBytes ||
              (result.consumedBytes === 0 &&
                appended.length >= maxScanBytes - scanned)
            ) {
              return false;
            }
            if (now() >= deadline) return false;
            await sleep(pollMs);
          }
        },
      };
    },
  };
}
