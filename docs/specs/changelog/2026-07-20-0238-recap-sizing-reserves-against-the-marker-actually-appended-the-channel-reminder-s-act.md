## 2026-07-20 — Recap sizing reserves against the marker actually appended, the channel reminder's action step is sequenced list-then-ack everywhere, and the coalesced-until-ack guard's band scope is documented correctly (002 §9.2, 006 §4.2.1, §5.1.1) — Refs #438, #434, PR #445 review round 3

Three more follow-on defects found on round 3 of reviewing the same change.

**1. `resolveHookClaimFit` sized against the wrong marker for a `post-compact` recap (BLOCKER).**
`resolveHookClaimFit` defaulted to reserving room for `buildHookDeferredMarker`'s length regardless of
lifecycle, but `renderHookDelivery`'s recap branch appends the LONGER `buildHookRecapMarker` on top of
that packing instead. Reserving against the shorter marker while appending the longer one could let a
multi-event recap's rendered `additionalContext` exceed `MAX_ADDITIONAL_CONTEXT` (4000 chars). Resolved
by threading the lifecycle-specific marker `renderHookDelivery` will actually append into
`resolveHookClaimFit` as an explicit parameter, so `includedCount` stays truthful for both lifecycles.
Regression test: a two-event recap boundary case (`hook-deliver-render.test.ts`) with a body length of
3546 chars — the smallest size that genuinely overflows the cap under the pre-fix packing.

**2. A stale channel-transport example still showed the bare-ack "OR" wording (§4.2.1) swept.** Round 2
(below) fixed the channel reminder's rendered text and its spec prose, but left an illustrative example
in `experiments/channel-uat/README.md` quoting the old "Call the agentmon_ack tool, or run `events
list` ... for details" shape. Updated to the current list-then-scoped-ack wording so no reader copies
the superseded phrasing.

**3. The coalesced-until-ack suppression's spec prose and changeset overclaimed cross-band scope
(§5.1.1).** Both `docs/specs/006-agent-integration.md` and the `self-sufficient-delivery-text`
changeset described an unacknowledged claim as suppressing "every subsequent"/"every later"
normal-urgency reminder for the session — but the guard
(`normalPending.length === unreadNormal.length`; the low-urgency guard, §9.3, is the identical pattern)
is band-scoped: it compares a band's own claimed-but-unacknowledged events against that SAME band's
unread total. An unacknowledged `high`-urgency (or mixed-band recap) claim does not, on its own, block a
NEW `normal`-urgency reminder from firing for unrelated, still-unclaimed `normal` events in the same
session — the two coexist. Corrected both the spec prose and the changeset; added a regression test
(`service.test.ts`, "cross-band independence") proving an unacked high-urgency claim does not suppress a
same-session normal-urgency reminder.

