/**
 * Claude Code session-transcript evidence for channel delivery (006 §4.5.2).
 *
 * A channel push that resolves proves nothing: a host that loaded the channel
 * server without a channel listener drops the event and still reports success
 * (006 §12.6). Claude Code, when it *does* accept a channel event into a
 * session, appends a `queue-operation` entry with operation `enqueue` to that
 * session's transcript, whose `content` is the rendered `<channel …>` tag. That
 * entry, carrying the push's own delivery identifier, is the host's
 * confirmation that the push reached the session.
 *
 * The transcript format is undocumented host behaviour, so everything that
 * knows its shape lives here in the Claude adapter, never in the runtime core.
 * This module is pure: it inspects bytes the caller has already read and
 * returns a verdict. It never opens files, and it keeps nothing it reads —
 * the only output is whether a matching entry was seen and how many bytes of
 * complete lines were consumed.
 *
 * Matching is deliberately strict. Anything that is not exactly a
 * `queue-operation`/`enqueue` entry for this host session whose opening
 * `<channel` tag carries ` delivery_id="<id>"` is not a confirmation. An
 * unrecognised shape therefore counts as unconfirmed — the safe direction,
 * since an unconfirmed push is released to the hook path (PP1).
 *
 * @see ../../../../docs/specs/006-agent-integration.md §4.5.2
 */

import path from 'node:path';

/**
 * The channel meta key whose value identifies one push. Claude Code renders
 * each meta entry as an attribute on the `<channel>` opening tag, which is
 * where {@link scanClaudeTranscriptForChannelPush} looks for it.
 */
export const CHANNEL_DELIVERY_ID_META_KEY = 'delivery_id';

/** What a channel push must be matched against. */
export interface ChannelPushConfirmationQuery {
  /** The fresh, per-push identifier the channel sent in its notification meta. */
  deliveryId: string;
  /** The Claude Code session the channel is bound to. */
  hostSessionId: string;
}

/** The outcome of scanning one slice of appended transcript bytes. */
export interface ChannelPushScanResult {
  /** A matching `enqueue` entry was found in a complete line. */
  confirmed: boolean;
  /**
   * Bytes of complete (newline-terminated) lines consumed from the start of
   * the slice. A trailing partial line is left unconsumed so the caller can
   * re-read it once the host finishes writing it.
   */
  consumedBytes: number;
}

/**
 * Delivery identifiers are minted by the channel as lowercase hex. Restricting
 * the accepted shape keeps the attribute match exact: no escaping in the
 * rendered tag can ever change a value made only of these characters.
 */
const DELIVERY_ID_PATTERN = /^[0-9a-f]{16,64}$/;

/** Whether a string is a well-formed channel delivery identifier. */
export function isChannelDeliveryId(value: string): boolean {
  return DELIVERY_ID_PATTERN.test(value);
}

const NEWLINE = 0x0a;
/**
 * Every transcript entry Claude Code writes is one compact JSON object per
 * line with `type` as its first key. A line that does not begin with this
 * prefix is not a queue operation and is never parsed.
 */
const QUEUE_OPERATION_PREFIX = Buffer.from('{"type":"queue-operation"', 'utf8');

function startsWithPrefix(bytes: Uint8Array, start: number, end: number) {
  if (end - start < QUEUE_OPERATION_PREFIX.length) return false;
  for (let i = 0; i < QUEUE_OPERATION_PREFIX.length; i++) {
    if (bytes[start + i] !== QUEUE_OPERATION_PREFIX[i]) return false;
  }
  return true;
}

/**
 * Whether one parsed transcript entry is the `enqueue` of this push.
 *
 * The delivery id must sit in the `<channel …>` opening tag — the first line
 * of the rendered content up to its first `>` — as an exact
 * ` delivery_id="<id>"` attribute token. A matching id anywhere else (the
 * event body, a different tag) does not count.
 */
function isEnqueueOfPush(
  entry: unknown,
  query: ChannelPushConfirmationQuery,
): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return false;
  }
  const record = entry as Record<string, unknown>;
  if (record['type'] !== 'queue-operation') return false;
  if (record['operation'] !== 'enqueue') return false;
  const sessionId = record['sessionId'];
  if (sessionId !== undefined && sessionId !== query.hostSessionId) {
    return false;
  }
  const content = record['content'];
  if (typeof content !== 'string' || !content.startsWith('<channel ')) {
    return false;
  }
  const tagEnd = content.indexOf('>');
  if (tagEnd < 0) return false;
  const openingTag = content.slice(0, tagEnd);
  return openingTag.includes(
    ` ${CHANNEL_DELIVERY_ID_META_KEY}="${query.deliveryId}"`,
  );
}

/**
 * Scan transcript bytes appended since a push for that push's `enqueue`.
 *
 * Only complete lines are examined; only lines beginning with the
 * queue-operation prefix are parsed. A malformed id in `query` never matches.
 */
export function scanClaudeTranscriptForChannelPush(
  appended: Uint8Array,
  query: ChannelPushConfirmationQuery,
): ChannelPushScanResult {
  if (!isChannelDeliveryId(query.deliveryId) || query.hostSessionId === '') {
    return { confirmed: false, consumedBytes: 0 };
  }
  let lineStart = 0;
  for (let i = 0; i < appended.length; i++) {
    if (appended[i] !== NEWLINE) continue;
    const lineEnd = i;
    if (startsWithPrefix(appended, lineStart, lineEnd)) {
      let entry: unknown;
      try {
        entry = JSON.parse(
          Buffer.from(
            appended.buffer,
            appended.byteOffset + lineStart,
            lineEnd - lineStart,
          ).toString('utf8'),
        );
      } catch {
        entry = undefined;
      }
      if (isEnqueueOfPush(entry, query)) {
        return { confirmed: true, consumedBytes: lineEnd + 1 };
      }
    }
    lineStart = lineEnd + 1;
  }
  return { confirmed: false, consumedBytes: lineStart };
}

/**
 * Whether a hook-supplied `transcript_path` is usable as this session's
 * confirmation source: absolute, and named `<hostSessionId>.jsonl`, which is
 * how Claude Code names a session's transcript. Anything else is treated as no
 * evidence source at all (the channel route stays unproven).
 */
export function isClaudeTranscriptPathForSession(
  transcriptPath: string,
  hostSessionId: string,
): boolean {
  if (hostSessionId === '' || !path.isAbsolute(transcriptPath)) return false;
  return path.basename(transcriptPath) === `${hostSessionId}.jsonl`;
}
