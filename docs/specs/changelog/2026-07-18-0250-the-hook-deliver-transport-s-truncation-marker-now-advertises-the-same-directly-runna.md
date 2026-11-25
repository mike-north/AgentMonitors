## 2026-07-18 — The hook-deliver transport's truncation marker now advertises the same directly-runnable, session-scoped recovery command as the channel transport (006 §5.1, §5.5) — Refs #442

Parity fix following the channel-side fix directly below: `hook-deliver-render.ts`'s `TRUNCATION_MARKER`
had the identical defect — it advertised `agentmonitors events list --unread`, but `events list`
requires `--session <id>` (§5, issue #420 P2), so the exact advertised command exits 1. The constant is
replaced by `buildHookTruncatedMarker(sessionId)`, mirroring `buildChannelTruncatedMarker`: it renders
the directly-runnable `agentmonitors events list --session <id> --unread` for the claim that actually
received it, sanitized the same way every other claim-derived field reaching `additionalContext` is.
Unlike the channel side, the hook transport keeps a SINGLE marker builder for both the deferred-remainder
branch and the single-event mid-truncation branch (§5.5) — `claimDeliveryClient` claims synchronously
(no two-phase reserve/commit), so there is no "will re-deliver later" framing on the hook side that
session-scoping would undermine. `packEventsUnderCap` (both the exported hook-deliver wrapper and its
callers in `hook.ts`/`verify.ts`) now takes the claim's `sessionId` so pre-claim sizing reserves room
for THIS session's own marker length, not a fixed constant — a longer or shorter session id changes how
many whole event blocks fit under the 4000-char cap. §5.1's example marker text is updated to show the
session-scoped command.

