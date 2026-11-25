## 2026-07-12 — Fix silent opt-in dead-end: `SessionStart` advisory when monitors exist but the project is disabled (006 §5.6, 002 §10.2) — Refs #269

`session start`'s quick-exit for a not-enabled project was **fully silent** in every case,
including when the workspace already has `.claude/monitors/**` definitions and the user simply
never flipped `enabled: true` in `.claude/agentmonitors.local.md`. That combination was the worst
onboarding dead-end: monitors sit unobserved and nothing ever says why, forever.

- **006 §5.6 — extended (current).** Added a "Monitors-found-but-disabled advisory" bullet
  alongside the existing CLI-absent-guard bullet: `session start` now scans `.claude/monitors`
  before quick-exiting on a disabled project. Zero definitions found → unchanged fully-silent
  quick-exit (never nag a user who hasn't opted in at all). One or more found → a single
  `additionalContext` advisory (monitoring disabled, N monitors found, the exact enable step),
  still exiting 0 without opening a session or booting a daemon.
- **002 §10.2 — clarified (current).** The "Lazy boot" section's quick-exit description now
  cross-references 006 §5.6 for this case rather than leaving the reader to infer "not enabled"
  always means silent.
- This is a deliberately narrow fix: no auto-enabling, no advisory on any hook other than
  `SessionStart`, no change to the enabled-path behavior. See the non-goals in issue #269.

