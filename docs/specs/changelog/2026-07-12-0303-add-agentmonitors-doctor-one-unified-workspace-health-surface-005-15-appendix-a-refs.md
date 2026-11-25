## 2026-07-12 — Add `agentmonitors doctor`: one unified workspace health surface (005 §15, Appendix A) — Refs #267

Answering "is my monitoring working, and if not, where is it broken?" required stitching together
`daemon status`, `monitor explain`, `events list`, and `session list` and knowing non-obvious
distinctions (host vs AgentMon session ids; `monitor explain` verdicts that can disagree with
`events list`). There was no single health surface and no per-monitor last-observed / next-due
rollup — the #1 gap for "easy to see that it's working". `doctor` formalizes the ad-hoc probes the
setup-monitors skill performs into a first-class diagnose-only command.

- **005 §15 — new section (current).** Documents `agentmonitors doctor`: the named check sequence
  (`project-enabled`, `monitors-directory`, `monitors-valid`, `daemon-reachable`, `lead-session`,
  and per-monitor `monitor:<id>`), each with a pass/fail/skip status and an actionable remediation;
  exit 0 iff all checks pass. The per-monitor rollup (id, source type, cadence, last-observed,
  next-due, last-event, and unread/claimed/acknowledged counts for the workspace lead session, or an
  explicit never-observed / no-lead-session marker) and the stable `--format json` shape are
  specified here. `doctor` reads durable state **in-process** (accurate whether or not a daemon is
  running, like `daemon status` and `monitor explain`'s #150 read); the socket is used only for the
  `daemon-reachable` ping.
- **005 §15/§16 — renumber.** The former "Exit codes & diagnostics" section is now §16 (no other doc
  cross-references it).
- **Deliberately narrow (current).** Diagnose-only: no `--fix`, no host-plugin/MCP/channel checks,
  and no change to `monitor explain` (issue #267 non-goals). The `project-enabled` remediation names
  the same enable step as the `SessionStart` monitors-found-but-disabled advisory (006 §5.6) —
  creating `.claude/agentmonitors.local.md` with `enabled: true` — but leads with `agentmonitors init
--enable-only` (005 §2, Refs #268), the one-shot bootstrap command that now does that for you, so
  all three onboarding surfaces agree.
- **Core (current).** The workspace-wide durable-state diagnosis lives in
  `AgentMonitorRuntime.doctorReport()` (host-agnostic, per AP6), reusing the same store reads and
  scheduling logic as `explainMonitor`. The CLI layers the project-enabled and daemon-reachable
  checks (CLI-only concerns) and renders.

