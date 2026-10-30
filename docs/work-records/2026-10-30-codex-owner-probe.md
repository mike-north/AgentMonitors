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
