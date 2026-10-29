## 1. Reconcile the contract

- [ ] 1.1 Confirm the `~user` and user-level bare-relative error literals (this change carries the 003 §3.5 wording; 001 §6.1 differed) and record the decision in `design.md`
- [ ] 1.2 Confirm the absolute + home-relative mixing rule (allowed with a warning) with the owner and record the decision in `design.md`
- [ ] 1.3 Choose the mechanism that tells `agentmonitors validate` a monitors root is user-level (e.g. `--user-level`) and add it to `cli/authoring-commands`

## 2. Source-side resolution (`@agentmonitors/source-file-fingerprint`)

- [ ] 2.1 Classify each `globs`/`ignore` pattern by leading character (`/` absolute, `~` home-relative, otherwise project-relative)
- [ ] 2.2 Expand `~` and `~/…` via the OS home directory into absolute patterns with no `cwd` involvement
- [ ] 2.3 Remove the daemon-process-cwd fallback for user-level monitors (no `workspacePath`)
- [ ] 2.4 Unit tests: classification of each class; `~` alone and `~/…` expansion against a stubbed home directory; absolute patterns ignore `cwd`; project-relative project monitor resolution unchanged

## 3. Validation (`agentmonitors validate`)

- [ ] 3.1 Add user-level context to `validate` and reject bare-relative globs in user-level monitors with the specified message referencing #258
- [ ] 3.2 Reject `~user` patterns with the specified message
- [ ] 3.3 Reject absolute + project-relative and home-relative + project-relative mixes (in `globs` and in `ignore`) with the split-into-two-monitors message; warn (not reject) on absolute + home-relative
- [ ] 3.4 Docker-backed / CLI integration tests: `validate --user-level` with `globs: ['src/**/*.ts']` exits non-zero referencing #258; `globs: ['~alice/notes.md']` exits non-zero; `globs: ['/var/log/x', 'src/foo.ts']` exits non-zero; `globs: ['~/notes/x.md']`, `['/var/log/x.log']`, and `['/etc/hosts']` are accepted
- [ ] 3.5 CLI test: project-level `validate` with `globs: ['src/**/*.ts']` still exits 0 (no regression)

## 4. Runtime and projection

- [ ] 4.1 Evaluate user-level monitors with no `workspacePath` so their events materialize with `workspacePath: null`
- [ ] 4.2 Integration test: a home-relative user-level monitor's event has `workspacePath: null` and projects into a lead session for a different workspace (proves the workspace-agnostic projection path)
- [ ] 4.3 Integration test: an absolute user-level monitor's event has `workspacePath: null`

## 5. Release collateral

- [ ] 5.1 Add a changeset for `@agentmonitors/source-file-fingerprint` and `@agentmonitors/cli` (and `@agentmonitors/core` if helpers are exported)
- [ ] 5.2 Regenerate API reports if a public surface changes (`pnpm --filter <pkg> run fix:api-report`)
- [ ] 5.3 Document user-level `file-fingerprint` monitors (`/…` and `~/…` forms, rejection rules, the home-relative example) in `apps/website`
