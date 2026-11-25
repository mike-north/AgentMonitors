## 2026-08-24 — New numbered doc: 008 — Reliability & Process Hygiene — Refs #504, PR #476

Added [008-reliability-process-hygiene.md](../008-reliability-process-hygiene.md), promoting the
product posture of `docs/product/reliability-and-process-hygiene.md` (landed in PR #476) into
normative, testable spec text: the containment-boundary definition and its five-state
exhaustiveness (incl. the reported deferred-reconciliation state), spawned-process lifecycle
bounds (original-process-group/`taskkill`-tree timeout escalation is **current**, proven by
the `source-command-poll` no-orphan guards; full-boundary and daemon-death-independent bounds
are **target**, #480/#470), the restart sweep (#478) and the adjacent daemon/channel-server/socket
hygiene (#426), identity-verified cleanup with the
prefer-a-leak-to-a-wrong-kill bias (#479), the abstention/escape taxonomy with the active
abstention-warning surface (#507), the capability probe + achieved-guarantee reporting with an
explicit no-user-tier rule and a normative three-rung capability ladder (#480), the power
posture (#469), and the cross-cutting durable-state-truthfulness (§9) and verification-gate
(§10) commitments required by #504 (mechanisms owned by 002; commitment level owned by 008).
Cross-references added to the spec README and 000 §7; the posture doc now links here as its
realizing spec. Each target rule carries a test implication that serves as the acceptance bar
for its tracking issue.

Two contradiction resolutions recorded per 004 §5, both surfaced by PR #512 review:

- **§3.1's "whole-tree" timeout escalation was an overclaim.** On POSIX the implementation
  signals the command's _original process group_ (`process.kill(-pid, …)`); a descendant that
  re-sessions (keeping its identity) empirically survives the escalation. §3.1 is now scoped
  (current) to the original-group/`taskkill /T` mechanism class; full-boundary deadline
  bounds are the new §3.2 **target** owned by #480's containment ladder, with the sweep as
  lower-rung reconciliation.
- **#478's original scope excluded descendants detached into an independent session**, while
  008 §2.1 deliberately keeps detached-but-identifiable descendants inside the containment
  boundary. Resolution: #478's scope is extended (recorded on the issue) to cover
  detached-but-identifiable descendants; identity-erasing detachment remains the documented
  escape.

