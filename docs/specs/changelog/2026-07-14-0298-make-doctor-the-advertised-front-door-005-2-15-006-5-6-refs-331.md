## 2026-07-14 — Make `doctor` the advertised front door (005 §2, §15; 006 §5.6) — Refs #331

A blind DX study (5 subjects) found 3 of 5 discovered `agentmonitors doctor` only by `--help`
spelunking — nothing pointed to it: not `init`'s closing summary, not error messages, not
remediation texts. Separately, running `doctor` right after the `setup-monitors` skill's
documented manual-verify recipe produced a scary-looking failing summary with no cue that
`lead-session`/`daemon-reachable` failing is expected once the recipe's throwaway daemon/session
are torn down.

- **005 §2 — both `init` forms' closing output (current).** The bootstrap form's "What happens
  next" summary (and its idempotent "nothing to change" re-run) and the named `init <name>`
  scaffold form's closing hint now both name `agentmonitors doctor` as the health-check next step.
- **005 §1 — manual daemon-unreachable message (current).** The shared "no daemon running for this
  workspace" stderr line (`session open/close/list`, `events list/ack`, `hook claim`) now also
  points at `agentmonitors doctor` for the full picture, alongside the existing `daemon run`
  fix-it command.
- **006 §5.6 — `SessionStart` monitors-found-but-disabled advisory (current).** The advisory text
  now also names `agentmonitors doctor`, not just the enable step.
- **005 §15 — `daemon-reachable`/`lead-session` fail-line wording (current).** Both checks' fail
  `detail` text gains one clause of context: this state is expected when no agent session is
  currently open (the common post-manual-verify state), not evidence of a broken setup. The
  exit-code contract is unchanged (issue #331 non-goal) — only the wording changed.

