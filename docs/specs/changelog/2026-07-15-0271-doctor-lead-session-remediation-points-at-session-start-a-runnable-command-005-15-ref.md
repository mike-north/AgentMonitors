## 2026-07-15 — `doctor` lead-session remediation points at `session start`, a runnable command (005 §15) — Refs #387

`doctor`'s `lead-session` remediation previously recommended `agentmonitors session open --role lead
--workspace <path>`. That command is not runnable as printed: `session open`'s `--host-session-id`
is a required option, so a copy-paste fails immediately with `error: required option
'--host-session-id' not specified`, and a manual/no-plugin CLI user has no meaningful value to supply
for it ("host session id from the integrating runtime"). In a blind usability evaluation this was the
first dead end a manual CLI user hit — reached by following the tool's own printed advice.

Fixed by pointing the remediation at `agentmonitors session start` — the flagless lazy-boot path that
matches real usage (the `SessionStart` hook runs exactly this command; 005 §10.4): it boots the
project daemon if needed and registers a lead session in one shot, and has no required options so it
can never fail with a missing-required-option error. For the manual case the hint now prints the exact
stdin payload `session start` reads (`session_id` + `cwd`, delivered as JSON on stdin like a real hook)
with an explicit `manual-cli-session` placeholder, so the printed command runs verbatim. The existing
issue #335 self-diagnosing invariant is preserved: the `detail` and remediation still name the exact
workspace path doctor searched. `session open`'s own required-flag contract is unchanged (non-goal).

