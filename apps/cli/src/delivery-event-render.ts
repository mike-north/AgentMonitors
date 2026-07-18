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
 * channel rendered only the event *title*, silently dropping the monitor body and
 * the change summary the hook path already injected (issue #436).
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
 * Truncate `diff` to at most {@link MAX_EVENT_DIFF} code units, cutting at a
 * Unicode code-point boundary (never splitting a surrogate pair) and appending
 * {@link DIFF_ELISION_MARKER} when truncation occurs so the marker-included
 * result is still ≤ the cap.
 */
function boundDiff(diff: string): string {
  if (diff.length <= MAX_EVENT_DIFF) return diff;
  const budget = Math.max(0, MAX_EVENT_DIFF - DIFF_ELISION_MARKER.length);
  let out = '';
  for (const ch of diff) {
    if (out.length + ch.length > budget) break;
    out += ch;
  }
  return out + DIFF_ELISION_MARKER;
}

/**
 * Render one {@link DeliveryEventSummary} into its transport block:
 *
 * ```text
 * ### <monitorId> (<urgency>)
 * <title>
 *
 * <body>
 *
 * Changes:
 * <bounded diffText>
 * ```
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
  let block = `### ${id} (${urgency})\n${title}\n\n${body}`;
  if (event.diffText && event.diffText.trim().length > 0) {
    const diff = sanitize(boundDiff(event.diffText));
    block += `\n\nChanges:\n${diff}`;
  }
  return block;
}
