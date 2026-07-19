---
'@agentmonitors/cli': minor
'agentmonitors': patch
---

Add a delivery-transport health surface so a broken listening method is visible instead of silent.

A monitor can look completely healthy — events materialized on real transitions, monitor `explain`
clean — while nothing ever reaches the agent. Three distinct instances of this were observed in a
single day of dogfooding: a reaped daemon with no session to revive it, a channel server bound to
the home-directory workspace because the session was launched from `$HOME`, and correct events whose
reminders were withheld on every lead session by the `coalesced-until-ack` guard. All three
presented identically (silence) and needed completely different fixes.

- **Transport heartbeats.** `channel serve` records a heartbeat on startup and every poll (removing
  it on clean shutdown); `hook deliver` records one per invocation once it resolves a session, plus
  the delivery timestamp when it surfaces something. Each record names the pid, resolved CLI path
  and version, `HOME`/data root, bound workspace and socket, host session id, and last delivery —
  the values a long-lived transport freezes at session start and that silently stop matching
  reality. Records carry an explicit TTL lease, so a server killed without cleanup is recognized as
  dead without trusting it to have removed its own file. They live in a machine-wide registry under
  the data root rather than the per-workspace directory, which is what makes a transport bound to
  _another_ workspace findable at all.
- **`doctor` gains a "Delivery transports" section**, two `transport:<name>` checks, and a
  `delivery-verdict` check. Each failure mode is reported with its own code and its own remediation,
  never collapsed into a generic "unhealthy": `daemon-unreachable`, `workspace-mismatch`,
  `socket-mismatch`, `environment-mismatch`, `reminders-suppressed` (naming
  `agentmonitors events ack --session <id>`), `heartbeat-stale`, and `version-skew`.
- **The verdict separates "which method is listening" from "will anything arrive right now."**
  `deliveryWillReachThisSession` names the method (`hook` / `channel` / `both` / `none`);
  `deliverable` is the answer a user actually wants. They diverge exactly in the suppression case —
  reporting only the method is what let a real CI failure go undelivered while every surface looked
  green.
- **`--json` exposes** `transports[] { name, configured, running, healthy, boundTo, version,
lastDelivery, problems[] }` plus top-level `deliveryWillReachThisSession`, `deliverable`,
  `verdict`, and `remediation[]`. Pipeline-wide problems (a down daemon, muted reminders) are
  recorded on every configured transport but rendered once, at the verdict.
- **Exit codes stay conservative.** A `transport:<name>` check fails only for a transport that
  reported in and is genuinely broken. "A lead session exists but no transport has reported in yet"
  is `idle` — the ordinary state of a script-registered or freshly-opened session.
- The channel MCP server now reports the **real package version** in its handshake instead of a
  hardcoded `0.0.0`, so a host log identifies which build is serving the session.
- A live channel also carries a `channel-registration-unverified` **advisory** (not a defect): during
  the channels research preview the host silently drops channel events when the plugin is loaded as a
  plain MCP server, and never tells the server, so "connected" cannot prove registration. It points
  at `agentmonitors verify` and the dev-flag remediation.

See docs/specs/006-agent-integration.md §12 and docs/specs/005-cli-reference.md §15.
