## 2026-07-19 — Transport-health review fixes: registry GC, lead-session gating, non-blocking version-skew (006 §12; 005 §15) — Refs #425

Review of the initial delivery-transport health surface (below) found several defects that made the
surface report `fail` for a workspace with nothing genuinely broken, or blame the wrong side of a
failure:

- **Registry GC + lead-session gating (blocker).** Records were removed only on clean shutdown, so an
  uncleanly-killed transport's heartbeat sat on disk forever, past its own TTL — and the
  `transport:<name>` check applied the "no lead session → skip/idle" discipline only to a transport
  that had never reported in, not to one whose stale heartbeat was found on this scan. One
  uncleanly-killed channel server therefore failed every future `doctor` run in that workspace
  permanently, including with no session open, contradicting §15's own "no lead session → both
  transport checks are idle" text. Fixed by reaping expired-past-TTL records opportunistically on both
  read and write, and by extending the lead-session gate to the configured-transport branch too.
- **Hook `lastDeliveryAt` erased on the next empty prompt (blocker).** Hook heartbeat writes were
  whole-record overwrites; the first per-invocation write (before delivery is known) omitted
  `lastDeliveryAt`, silently resetting it to `never` on any subsequent prompt with nothing pending.
  Fixed by making the write read-modify-write on that one field, and by recording it only when
  `flow.output` was actually non-null (written to the host), not on every reservation that merely
  committed.
- **`version-skew` made informational, not blocking.** It made `doctor` exit non-zero for up to the
  hook's 24h TTL after every single CLI upgrade — the hook heartbeat legitimately carries the
  pre-upgrade version until the next prompt — directly contradicting its own "No action needed"
  remediation. Now behaves like `channel-registration-unverified`: reported, never blocking.
- **Registry key collisions.** The sanitized heartbeat key collapsed distinct raw ids to the same
  filename (`run:1`/`run_1`, or two ids differing only past the 96-char truncation point). Fixed by
  appending a short hash of the raw id.
- **Channel heartbeat coupled to poll completion.** Refreshing only after the reserve/commit/release
  IPC settled let a daemon wedged past the channel's TTL blame the transport for the daemon's outage.
  Fixed with an independent refresh timer.
- **Session-id-first matching wrongly applied to `hook`.** Only `channel` (one long-lived process per
  host session) should match by session id across workspaces; `hook` (a fresh per-prompt process with
  no per-session identity, keyed per workspace) now matches by workspace only.
- **Idle transport checks now always carry a remediation**, in both text and `--json`.
- Cleanup: the XDG data-root and workspace-hash derivations, previously duplicated across
  `workspace-paths.ts`, `transport-heartbeat.ts`, and `daemon-ipc.ts`, now have one canonical source
  (`workspace-paths.ts`); `getCliVersion()` is memoized; `computeTransportHealth`'s `HOME`/data-root
  comparison now takes `expectedHome`/`expectedDataRoot` as input instead of reading them live,
  restoring the purity its own doc comment already claimed.

