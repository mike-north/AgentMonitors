# Codex owner diagnostic — bounded implementation record

Scope: partial diagnostic for #316, not its adapter implementation. The issue remains blocked on
live binding-probe evidence and delivery/lifecycle verification. No published API changes or
Changeset are required for this standalone experiment.

- Added tests before `codex-owner.mjs`; first run failed on the missing module.
- Local protocol grounding: installed `codex app-server proxy --help` describes proxying stdio
  bytes to an explicit `--sock`; `generate-json-schema` supplied the loaded-list pagination and
  metadata-only thread-read shapes. Schema generation did not start a server. The probe uses
  direct Node Unix socket I/O and a fixed read-method allowlist, with no child-process execution.
- Synthetic fixtures verify initialization/version, loaded identity before and after metadata,
  pagination, missing/invalid replies, unloaded races, bounded waits/response sizes, disconnects,
  server-request refusal, explicit arguments, no mutation methods, and CLI output minimization.
- Validation: `npm --prefix experiments/host-probe test` passed 39 tests in two files (24 new
  Codex-owner tests); `node --check experiments/host-probe/codex-owner.mjs` and `git diff --check`
  passed. Existing production build/check suites were not run: production source and dependencies
  are unchanged, and this harness is a standalone npm experiment.
- No live host endpoint was supplied or contacted. No desktop support, receiver delivery,
  lifecycle coverage, or semantic-parity claims follow from these synthetic tests.
- Independent review remains required before integration. No push or merge is authorized in this
  implementation subtask. Personal Slack transcripts and earlier delivery prototypes were not
  copied or edited.

## Independent review repair

Independent reviewer rejected c40e6cb: a valid final loaded-list response followed in the same
socket chunk by malformed JSON, a peer approval request, or a duplicate response returned
owner-observed despite a recorded failure. That reviewer then became repair author; a different
reviewer must independently review the successor before integration.

Four regression tests were added before the fix: all four failed while the prior 39 passed.
Three cover the same-chunk terminal failures; the fourth injects a socket error between final
response handling and the successful-return continuation. A final connection-health check now
rejects those already-observed failures. The documentation bounds this guarantee to the inspected
snapshot interval, without waiting for future peer activity.

After repair, all 43 experiment tests passed. The separate synthetic-socket reproducer also
rejects all three terminal-tail modes with the appropriate errors. No real endpoint was contacted
and no mutation method was sent. JavaScript syntax and diff whitespace checks passed. Production
behavior is unchanged. Running the root pnpm formatter launcher initialized missing root workspace
dependencies from the existing lockfile; tracked dependency files remained unchanged.
