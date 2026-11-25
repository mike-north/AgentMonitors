## 2026-07-18 — The mid-truncation marker's advertised recovery command is now directly runnable, and a candidate-set-growth race no longer drops the deferral marker (006 §4.2.1, §5.5) — Refs #442

Two follow-on fixes to the round-5 entry directly below, both found on the same PR's round-6 review.

- **The truncation marker's advertised command was unusable.** `CHANNEL_TRUNCATED_MARKER` told the
  agent to run `agentmonitors events list --unread` to recover a mid-truncated event's full body, but
  `events list` **requires** `--session <id>` (005 §11.1, issue #420 P2) — the exact advertised
  command exits 1. `CHANNEL_TRUNCATED_MARKER` (a constant) is replaced by
  `buildChannelTruncatedMarker(sessionId)`, which renders the directly-runnable
  `agentmonitors events list --session <id> --unread` for THIS claim's own `sessionId`, sanitized the
  same way every other claim-derived field reaching the `<channel>` tag body is (§4.6). Because
  `appendMarkerWithinCap` computes its truncation budget from the marker argument's actual length, a
  longer or shorter session id already yields correct cap sizing with no separate adjustment. §4.2.1
  and §5.5 are updated to describe the session-scoped command instead of the bare form.
- **A "candidate-set growth" race could silently drop the deferral marker.** The sizing preview may
  hold exactly one settled event (`maxEvents = 1`, `moreDeferred: false`) when a SECOND event settles
  before `reserveDelivery` runs; the resulting one-event claim genuinely fits, so the existing
  actual-claim-fit check (round-3 entry below) reported `fits: true` and returned early — but that
  check only asks "does the claimed set fit," never "did more settled work appear in the gap." The
  second, now-settled event was left pending with no marker signposting it, contrary to §5.5 ("the
  render omits any pending event ... signposting that more updates are pending").
  `reserveSizedChannelDelivery` now re-runs the same read-only settled-high preview once more, after a
  reservation is accepted, and compares it against the claimed event ids; any settled event not in the
  claim forces `moreDeferred: true` on the result.
- §4.2.1's blanket "`renderChannelEvent` renders every event ... it never drops a block to fit a cap"
  is corrected to name the single-event mid-truncation exception explicitly (previously only §5.5
  documented it — the two sections contradicted each other on this point).

