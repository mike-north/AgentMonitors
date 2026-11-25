## 2026-07-20 — Transport-health review round 5: dormant sessions no longer read as live, every active lead must be covered, corrupt timestamps can no longer become representative, a stale sibling can no longer hide behind a healthy one (006 §12; 005 §15) — Refs #425

A fifth review round, against the exact head that closed round 4, found four more defects — all
either a false clean bill of health, or the opposite (an idle state wrongly reading as a live
failure):

- **`doctor` treated a DORMANT lead session as if it were still open (blocker).** `hasLeadSession`
  meant "any lead session ever registered for this workspace", not "is one currently active" — a
  session a prior `session close` had already marked `dormant` still counted. This let a closed
  session's leftover, in-TTL hook heartbeat cross the CLI boundary as live: `lead-session` read
  `pass`, the per-monitor rollup showed delivery counts instead of the `lead-session=none` marker,
  and the JSON `leadSession` field read `true` — even though `computeTransportHealth`'s own
  `leadHostSessionIds` (round 3) already correctly excluded it, so `deliveryWillReachThisSession`
  disagreed with every other field about whether a session was open. `gatherDeliveryDiagnoses` also
  asked the daemon to diagnose the dormant session's suppression state, for no live process to answer.
  Fixed by deriving the ACTIVE lead-session set exactly once in `doctorCommand` and threading it
  through every check, the delivery-diagnosis fetch, the per-monitor rollup, and the JSON shape —
  `gatherDeliveryDiagnoses` now takes that filtered list directly rather than the whole report. A
  closed session is therefore `idle`/exit 0 everywhere, matching the pre-existing "no lead session at
  all → idle" contract this doc already stated (§15 below), rather than the round-4 fix's `fail`/exit 1
  for this same case, which contradicted it.
- **Proving one active lead is covered is not proving all of them are (blocker; new problem code
  `channel-lead-uncovered`).** With two active leads and a channel heartbeat matching only one, the
  round-4 fix ("at least one active lead has a matching channel heartbeat") was satisfied and reported
  a clean, workspace-wide `deliverable: true` / `channel.healthy: true` verdict — silently hiding that
  the second active lead has no channel listener at all. Fixed by comparing the matched host-session
  ids against the FULL active-lead set and reporting every uncovered one under a new, transport-owned,
  blocking problem code, `channel-lead-uncovered`.
- **A stale sibling's problem did not exclude the channel from the listening method (blocker).**
  `deliveryWillReachThisSession`/`deliverable` were computed from a hand-maintained list of four
  problem codes that disqualify a transport from counting as "listening" — a list that omitted
  `heartbeat-stale` (and would have omitted `channel-lead-uncovered` above too). With a fresh,
  healthy channel record for one active lead and a stale one for another, the union of both records'
  problems already made `channel.healthy: false`, but the listening-method check still counted the
  channel, so `deliveryWillReachThisSession` read `channel` and the verdict ended in "(healthy)"
  regardless. Fixed by deriving "does this problem disqualify a transport from listening" from the
  same non-shared/non-advisory problem classification `healthy` already uses, instead of a
  separately-maintained code list that could (and did) drift out of sync.
- **Representative selection could pick a corrupt or future-timestamped record over a valid current
  one (blocker).** Round 4 ranked by problem count first, specifically so a broken sibling session
  would be shown as the representative record rather than being hidden by a healthy one. That ranking
  backfired on corruption: an unparseable `updatedAt` contributes its own `heartbeat-stale` problem,
  so "most problems wins" could make a CORRUPT record the representative even alongside a perfectly
  healthy, current one — reporting `running: false`/`reach: none` for a transport that is actually up.
  A far-future timestamp had the mirror bug on a tie: its raw `Date.parse` value reads as "freshest"
  even though `isHeartbeatStale` independently treats it as stale, letting it shadow a valid current
  listener. Fixed by separating representative selection (now freshness-first, with unparseable AND
  out-of-tolerance-future timestamps both sorting as oldest) from problem aggregation (unchanged: every
  matching record's problems are still unioned regardless of which one is chosen as representative), so
  a broken sibling's problems are never hidden either way.

