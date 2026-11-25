## 2026-07-19 — Delivery-transport health surface + transport heartbeats (006 §12; 005 §15) — Refs #425

Nothing answered "what transport will actually deliver monitor events to THIS session, and is it
healthy?" Both transports can silently diverge from the workspace they serve, and every divergence
presents identically — silence — while every existing surface reports green. Three distinct
instances were observed in one day of dogfooding: (a) a reaped daemon with no session to revive it;
(b) a channel server bound to the home-directory workspace because the session was launched from
`$HOME`; and (c) correctly-materialized events whose reminders were withheld on every lead session
by the `coalesced-until-ack` guard (002 §9.2/§9.3) — including a CI failure the agent was never told
about. `monitor explain` diagnoses (c) correctly, but only if you think to run it, and nobody runs it
while things appear fine.

### 006 §12 — Transport health & heartbeats (_current_)

New section. Each transport now writes a **heartbeat**: `channel serve` on startup and every poll
(removed on clean shutdown), `hook deliver` per invocation once it resolves a session plus the
delivery timestamp when it surfaces something. A record names the pid, resolved CLI path/version,
`HOME`/data root, bound workspace and socket, host session id, and last delivery — precisely the
values a long-lived channel server freezes at session start and that stop matching reality without
any visible signal.

Two design points are load-bearing and stated as contract, not implementation detail:

- **Records carry an owner-declared TTL lease.** A server killed without cleanup leaves its file
  behind, so a reader must judge it dead without trusting the writer to have removed it. Declaring
  the bound in the record (rather than as a reader-side constant) keeps the judgement correct if a
  future writer heartbeats on a different cadence, and gives a lease primitive a later
  daemon-lifetime policy can consume directly. The channel's lease is short (tens of seconds); the
  hook's spans a day, because there is no hook process between prompts and a short lease would
  report a healthy setup as dead during any human pause.
- **Records live in a machine-wide registry under the data root**, not the per-workspace directory.
  Storing a channel heartbeat inside the workspace _it resolved_ would make failure mode (b)
  undetectable by construction. A transport under a genuinely different `HOME`/`XDG_DATA_HOME` is
  invisible from here and is reported as an **absence** whose wording names that possibility — never
  as a clean bill of health.

§12.4 states the surface's contract: name the listening method; report each cause **distinctly**
(never one generic "unhealthy"); attach a concrete remediation to every problem; and separate "which
method is listening" from "will anything actually arrive right now". §12.5 records what a heartbeat
**cannot** prove: during the channels research preview the host drops channel events silently when
the plugin is loaded as a plain MCP server and returns no error, so "connected" is not sufficient for
healthy. That is surfaced as an explicitly-unverifiable advisory (pointing at `verify` and the
dev-flag remediation) rather than asserting health we cannot prove or crying wolf; a future active
probe would upgrade it to detection.

Numbered §12 rather than inserted as §7 deliberately: renumbering would have invalidated existing
`006 §7`–`§11` cross-references across the spec set, the roadmap, the glossary, and historical
entries in this changelog.

### 005 §15 — `doctor` reports delivery transports

`doctor` gains a **Delivery transports** section, two `transport:<name>` checks, and a
`delivery-verdict` check, with problem codes `daemon-unreachable`, `workspace-mismatch`,
`socket-mismatch`, `environment-mismatch`, `reminders-suppressed`, `heartbeat-stale`,
`version-skew`, and the `channel-registration-unverified` advisory. The prior statement that `doctor`
"performs no MCP/channel checks" is removed as superseded.

`deliveryWillReachThisSession` (the method) and `deliverable` (will anything arrive) are separate
fields on purpose — the suppression case is exactly where they diverge, and collapsing them is what
hid the undelivered CI failure. Pipeline-wide problems are recorded on every configured transport in
`--json` but rendered once, at the verdict, so one down daemon does not read as one problem per
transport.

**Exit codes stay conservative.** A `transport:<name>` check is `fail` only for a transport that
reported in and is genuinely broken. "A lead session exists but no transport has reported in yet" is
`idle`, matching the existing `daemon-reachable`/`lead-session` idle discipline (issue #373): it is
the ordinary state of a script-registered session or one that has not yet had its first prompt, and
failing there would cry wolf on a setup about to be fine.

