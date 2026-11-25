## 2026-07-19 — PR-alerting presets become actionable-only membership sets at `high` urgency (003 §11.9, 005 §2) — Refs #444

Field testing a dogfooded author-side monitor overturned the `normal`-urgency choice recorded below.
Detection worked — three `monitor_events` materialized — but delivery was **suppressed on all four
lead sessions**, so the author was never told CI had failed. Two independent mechanisms cause this:

1. **Normal reminders are coalesced-until-acknowledgment** (002 §9.2). The implemented guard is
   `normalPending.length === unreadNormal.length`: every unread normal event must be unclaimed, so a
   single claimed-but-unacked normal event from **any** monitor suppresses the reminder for **all** of
   them. In an active session that is nearly always true, making a `normal` PR monitor structurally
   unreliable exactly when its audience has been working.
2. **Normal carries no event body mid-session** (002 §9.2/§9.3). Normal and low deliver a generic
   reminder with an empty `events` array; bodies arrive only at recap.

`high` is only safe if the payload cannot fire on non-events, so both presets now emit a **membership
set of actionable items** rather than full state. `my-prs` reduces each PR to a `needs` verdict
(`ci-failing`, `changes-requested`, `draft`, `merged`, `closed`) and drops it entirely when `none`;
`pr-review` admits only undecided, non-draft, non-release PRs authored by someone else. A green,
non-draft, undecided PR is absent, so an ordinary CI run produces no event. Encoding draft as
_membership_ rather than as a diffed `isDraft` field is what keeps both directions of draft↔ready
firing.

**Generalized rule:** `high` is defensible for a `json-diff` monitor when the payload is filtered so
that every _entering_ transition is actionable. `json-diff` is symmetric, so entries _leaving_ the set
(CI recovering, a review answered, a draft marked ready, a terminal PR aging out) also fire; the goal
is to bound those to one per resolved item, not to zero, and to name them in the monitor body so they
are cheap to dismiss. The presets no longer claim every fire is actionable.

**This reverses the `--state open` decision recorded in the entry below.** That change fixed a real
window-eviction risk, but it also collapsed `MERGED` and `CLOSED` into an indistinguishable
disappearance — and "merged, clean up the branch" versus "closed unmerged, find out why" are
different instructions the acceptance criteria require distinguishing. `--state all --limit 60`
restores nameable terminal states while addressing the eviction concern by widening the window
(measured ~3.5s per poll against a real repository; terminal PRs held 15 of 20 slots at `--limit 20`,
which is what motivated the widening). The residual risk — a still-open PR older than 60 newer PRs
aging out of the query — is documented in 003 §11.9 rather than silently accepted.

Note also that 002 §9.2's prose claims the coalesced reminder re-fires when "a fresh unclaimed normal
event arrives". The implemented guard does not do that: a fresh unclaimed event makes the two counts
unequal, keeping the reminder suppressed. The field observation matches the code, not the prose. That
inaccuracy is tracked separately and is not corrected here.

