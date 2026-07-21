import type { DeliveryEventSummary } from '@agentmonitors/core';

/**
 * Shared per-event block renderer for the two injecting transports — the
 * hook-deliver `additionalContext` path (`hook-deliver-render.ts`, 006 §5.1) and
 * the channel `<channel>` tag body (`channel-render.ts`, 006 §4.2). Keeping the
 * block shape in ONE place is what makes the two surfaces render the *same
 * event* equivalently (006 §6: "same events, same urgency ... only the surface")
 * — the only per-transport difference is the {@link sanitize} function each
 * passes (the hook preserves `<>[]`, the channel strips them for tag safety) and
 * the overall cap/truncation each applies afterward. Before this was shared, the
 * channel rendered only the event *title*, silently dropping the monitor body
 * (issue #436) — the `Changes:` change-summary section and
 * `DeliveryEventSummary.diffText` are BOTH new to this same change, on BOTH
 * transports; the hook path never had a change summary to drop either.
 */

/**
 * Per-event bound for the change summary (`diffText`). A raw diff can be
 * arbitrarily large and the rendered block lands in the agent's context window,
 * so each event's diff is truncated to this many UTF-16 code units before the
 * transport's own overall cap is applied (006 §4.6: surfaced content SHOULD be
 * bounded rather than dumping full untrusted bodies). Chosen so a single event's
 * change summary stays a *summary* — enough to see what moved — while leaving
 * room under the 4000-char transport caps for the title, body, and coalesced
 * sibling events.
 */
export const MAX_EVENT_DIFF = 800;

/**
 * Appended to a change summary that was cut at {@link MAX_EVENT_DIFF}. An
 * explicit elision marker so the agent knows the diff is partial and the full
 * change is still recoverable via `agentmonitors events list` (issue #436).
 */
export const DIFF_ELISION_MARKER = '\n… (change summary truncated)';

/**
 * Bytes that need no escaping at all inside {@link escapeShellPath}'s output —
 * deliberately conservative (alphanumerics plus the handful of characters a
 * filesystem path routinely contains: `/`, `.`, `_`, `-`). Everything else,
 * including plain POSIX shell metacharacters (spaces, quotes) AND every
 * `<channel>`-tag-breakout character (`< > [ ] ; \r \n`) and backtick, is
 * treated as unsafe and hex-escaped (see {@link escapeShellPath}).
 */
const PATH_SAFE_CHAR = /^[A-Za-z0-9/._-]$/;

/**
 * Render `value` (a filesystem path) as a shell-safe, tag-safe token that
 * ALSO round-trips to the exact original path when the advertised command is
 * run (issue #442, PR #442 round-8 review). Both truncation markers
 * (`buildChannelTruncatedMarker` in `channel-render.ts`, and the two markers
 * in `hook-deliver-render.ts`) interpolate an explicit `--socket <path>` into
 * their advertised `agentmonitors events list ...` recovery command using this
 * helper — one implementation shared by both transports so the two round-trip
 * guarantees can never diverge.
 *
 * A plain POSIX single-quote (the prior approach, `shellQuoteSingle`) is safe
 * for the SHELL — but on the channel transport the quoted result is embedded
 * directly into the `<channel>` tag body, bypassing `contentValue`'s own
 * sanitization pass (the marker text, socket path included, is appended
 * verbatim AFTER sanitization — see `renderChannelEvent`). A socket path is an
 * arbitrary filesystem path an attacker-influenced workspace name could shape,
 * e.g. `/tmp/x<channel>[oops].sock`; single-quoting alone preserves every byte
 * literally (that is the whole point of single-quoting), so the raw
 * `<`/`>`/`[`/`]` (and a raw CR or backtick, which can corrupt a code span or
 * the surrounding payload) would reappear in the pushed content unescaped —
 * violating 006 §4.6's tag-safety contract even though the shell-safety
 * contract was satisfied.
 *
 * The fix: render the path in bash/zsh **ANSI-C quoting** (`$'...'`), with
 * every byte outside the conservative {@link PATH_SAFE_CHAR} set (UTF-8
 * encoded, so a multi-byte code point becomes multiple `\xNN` escapes) emitted
 * as a `\xNN` hex escape. No raw forbidden byte can then appear in the tag
 * body — including a raw single quote itself, so no `'\''`-style
 * close/escape/reopen dance is needed — while `$'...'` still expands back to
 * the exact original path in `bash`/`zsh` when the advertised command is run.
 * When the path contains ONLY safe bytes (the common case — a plain,
 * unremarkable filesystem path), no escaping is needed at all and the simpler,
 * more readable plain single-quoted form is returned instead (matching the
 * PR's suggested "only ANSI-C-quote when necessary" refinement) — the two
 * quoting styles are both valid, round-trip-safe shell tokens; which one is
 * used depends only on whether `value` contains anything the safe set
 * excludes.
 */
export function escapeShellPath(value: string): string {
  let hasUnsafeByte = false;
  for (const ch of value) {
    if (!PATH_SAFE_CHAR.test(ch)) {
      hasUnsafeByte = true;
      break;
    }
  }
  if (!hasUnsafeByte) return `'${value}'`;

  let escaped = '';
  for (const ch of value) {
    if (PATH_SAFE_CHAR.test(ch)) {
      escaped += ch;
      continue;
    }
    for (const byte of Buffer.from(ch, 'utf8')) {
      escaped += `\\x${byte.toString(16).padStart(2, '0')}`;
    }
  }
  return `$'${escaped}'`;
}

/**
 * Truncate `value` to at most `cap` UTF-16 code units, cutting only at a
 * Unicode CODE-POINT boundary (never splitting a surrogate pair, which would
 * corrupt downstream JSON/tag serialization) and, when truncation occurs,
 * appending `marker` so the returned string — marker included — is still
 * ≤ `cap`. Shared by every injecting transport's truncation path: the
 * per-event diff bound below ({@link boundDiff}), the hook-deliver
 * `additionalContext` cap (`hook-deliver-render.ts`'s `truncateForCap`), and
 * the channel's overall packing marker (`channel-render.ts`). Before this was
 * shared, `boundDiff` and `truncateForCap` were character-identical copies of
 * this same code-point-safe truncation, differing only in their cap/marker
 * constants.
 */
export function truncateWithMarker(
  value: string,
  cap: number,
  marker: string,
): string {
  if (value.length <= cap) return value;
  const budget = Math.max(0, cap - marker.length);
  let out = '';
  for (const ch of value) {
    if (out.length + ch.length > budget) break;
    out += ch;
  }
  return out + marker;
}

/**
 * Truncate `diff` to at most {@link MAX_EVENT_DIFF} code units, cutting at a
 * Unicode code-point boundary (never splitting a surrogate pair) and appending
 * {@link DIFF_ELISION_MARKER} when truncation occurs so the marker-included
 * result is still ≤ the cap.
 */
function boundDiff(diff: string): string {
  return truncateWithMarker(diff, MAX_EVENT_DIFF, DIFF_ELISION_MARKER);
}

/**
 * Append `marker` to `body`, trimming `body` at a Unicode code-point boundary
 * (never splitting a surrogate pair) only if the marker would push the result
 * past `cap`, so the returned string — marker included — is always ≤ `cap`.
 * Unlike {@link truncateWithMarker} (which appends the marker only when
 * truncation is actually needed), this ALWAYS appends `marker` — it is for the
 * caller's already-decided "this must carry the marker" branch: the single
 * pathological case where one event's own block already exceeds the packing
 * cap and must be shown partially. Shared by both injecting transports
 * (`hook-deliver-render.ts`'s `additionalContext` cap and
 * `channel-render.ts`'s `MAX_CHANNEL_CONTENT`) so the mid-truncation of a
 * lone oversized event is implemented once.
 */
export function appendMarkerWithinCap(
  body: string,
  cap: number,
  marker: string,
): string {
  const budget = Math.max(0, cap - marker.length);
  if (body.length <= budget) return body + marker;
  let out = '';
  for (const ch of body) {
    if (out.length + ch.length > budget) break;
    out += ch;
  }
  return out + marker;
}

/**
 * Render one {@link DeliveryEventSummary} into its transport block:
 *
 * ```text
 * ### <monitorId> (<urgency>)
 * <title>
 * <objectDetail>
 *
 * <body>
 *
 * Changes:
 * <bounded diffText>
 * ```
 *
 * `<title>` is the monitor's authored name (002 §5.4); `<objectDetail>` is the
 * source's deterministic per-object text (`DeliveryEventSummary.objectDetail`,
 * never an Interpret digest, 002 §1.1.8) and is emitted only when it differs
 * from both the title and the body (they are identical for a monitor with no
 * authored `name`, which falls back to the source title; and derived from
 * `body` when a source supplies only `title` + `body`, 002 §5.1).
 *
 * The `Changes:` section is emitted only when the event carries a non-empty
 * `diffText`; the bounded diff is capped at {@link MAX_EVENT_DIFF} with an
 * explicit elision marker. A plain-text `Changes:` label (not a ```` ```diff ````
 * fence) is used deliberately: a diff can contain fence markers, and a fence
 * inside the injected content would be fragile.
 *
 * Every field is passed through `sanitize` so each transport enforces its own
 * content-safety rules (006 §4.6) on the same logical block: the hook path
 * preserves `<>[]` (its `additionalContext` is a JSON string, not tag-delimited),
 * while the channel path strips them so nothing can break out of the `<channel>`
 * tag. The block is otherwise identical across transports — that shared shape is
 * the rendering-parity contract.
 */
export function buildEventBlock(
  event: DeliveryEventSummary,
  sanitize: (value: string) => string,
): string {
  const id = sanitize(event.monitorId);
  const urgency = sanitize(event.urgency);
  const title = sanitize(event.title);
  const body = sanitize(event.body);
  // The title is the monitor's authored name (002 §5.4, issue #449) — it says
  // what the monitor is FOR, but not which object moved. `objectDetail` carries
  // the source's deterministic per-object text ("Incoming change:
  // docs/specs/001.md (modified)"), so it is rendered on its own line whenever
  // it adds something the title does not already say. Without it a per-object
  // source's delivery would name no object at all, which is exactly the
  // self-sufficiency #434/#438 requires.
  //
  // Deliberately `objectDetail`, NOT `summary`: `summary` prefers the Interpret
  // digest (G14, 002 §1.1.8) when one was produced, and a digest is a prose
  // reading of the change that carries no guaranteed object identity — using it
  // here could silently drop which object a multi-object `prose` monitor's event
  // is about (issue #449 review). `objectDetail` is never digest-replaced.
  // Falls back to `summary` only for a hand-constructed `DeliveryEventSummary`
  // (e.g. a test) that omits the newer field.
  const objectDetail = sanitize(event.objectDetail ?? event.summary);
  // Also skip when the detail IS the body: materialization derives an absent
  // `Observation.summary` from `body` (002 §5.1), so a source that supplies only
  // `title` + `body` would otherwise render its body twice — once here and once
  // in the template below (issue #449 review).
  const detail =
    objectDetail && objectDetail !== title && objectDetail !== body
      ? `\n${objectDetail}`
      : '';
  let block = `### ${id} (${urgency})\n${title}${detail}\n\n${body}`;
  if (event.diffText && event.diffText.trim().length > 0) {
    const diff = sanitize(boundDiff(event.diffText));
    block += `\n\nChanges:\n${diff}`;
  }
  return block;
}

/** The result of {@link packWholeBlocks}: the assembled text and how many
 * whole blocks it includes. */
export interface PackedBlocks {
  text: string;
  includedCount: number;
}

/** Options controlling how {@link packWholeBlocks} assembles its output. */
export interface PackWholeBlocksOptions {
  /** Fixed text prepended before any blocks (e.g. the hook's lead line). */
  header?: string;
  /** Joiner inserted between consecutive blocks. Defaults to `'\n'`. */
  joiner?: string;
}

/**
 * Greedily accumulate WHOLE blocks whose assembled string (`header` +
 * `joiner`-separated blocks) stays within `cap`. A block is added only when it
 * fits in full, so the visible set maps 1:1 to durable events — never a
 * partially-shown block, which would be a claimed-but-unread event with no
 * clean re-delivery boundary (issue #299). Shared by the hook-deliver
 * transport (whose blocks are joined by a single `\n` under a lead-line
 * header) and the channel transport (whose blocks are joined by a blank line,
 * `\n\n`, with no header).
 */
export function packWholeBlocks(
  blocks: string[],
  cap: number,
  options: PackWholeBlocksOptions = {},
): PackedBlocks {
  const header = options.header ?? '';
  const joiner = options.joiner ?? '\n';
  let body = '';
  let includedCount = 0;
  for (const block of blocks) {
    const candidate = body === '' ? block : `${body}${joiner}${block}`;
    if ((header + candidate).length > cap) break;
    body = candidate;
    includedCount += 1;
  }
  return { text: header + body, includedCount };
}

/** Options controlling {@link packEventsUnderCap}'s sizing. */
export interface PackEventsUnderCapOptions extends PackWholeBlocksOptions {
  /**
   * Length of the elision/truncation marker the caller will append when not
   * everything fits. Room for it is reserved so an INCLUDED block is never
   * cut. Defaults to `0` (no marker reserved).
   */
  markerLength?: number;
}

/**
 * How many WHOLE event blocks (from `events`, oldest-first) fit under `cap`
 * once rendered via {@link buildEventBlock} with `sanitize` and assembled with
 * `options` (header/joiner). The caller uses this to decide how many events to
 * CLAIM/reserve, so the claimed set equals the rendered set and the remainder
 * stays pending for the next poll/context event (006 §5.5).
 *
 * When not everything fits, room is reserved for `options.markerLength` so no
 * INCLUDED block is cut. At least 1 is returned when there is any event —
 * there must be forward progress: the first event is surfaced even if its own
 * body exceeds the cap, in which case the caller mid-truncates it with a
 * marker pointing at the still-unread full copy. Returns 0 for an empty list.
 */
export function packEventsUnderCap(
  events: DeliveryEventSummary[],
  sanitize: (value: string) => string,
  cap: number,
  options: PackEventsUnderCapOptions = {},
): number {
  if (events.length === 0) return 0;
  const blocks = events.map((event) => buildEventBlock(event, sanitize));
  const whole = packWholeBlocks(blocks, cap, options);
  // Everything fits → no marker needed → claim/reserve them all.
  if (whole.includedCount === blocks.length) return blocks.length;
  // A marker will be shown; reserve its room so an included block is never cut.
  const markerLength = options.markerLength ?? 0;
  const reserved = packWholeBlocks(blocks, cap - markerLength, options);
  return Math.max(1, reserved.includedCount);
}
