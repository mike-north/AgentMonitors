## 1. Probe diagnostics

- [ ] 1.1 Generalize the `experiments/channel-probe` diagnostic into a per-host binding probe that records the host version and the session-identity and workspace-binding signals
- [ ] 1.2 Run the probe for Codex CLI and Codex desktop; record lifecycle hooks, advisory-injection events, identity, workspace, baseline and richer transports
- [ ] 1.3 Run the probe for Cursor CLI and Cursor IDE; record the same dimensions
- [ ] 1.4 Decide per host whether the internal `surface: 'cli' | 'desktop'` branch is needed

## 2. Codex adapter (G19)

- [ ] 2.1 Implement `libs/core/src/adapter/codex.ts` satisfying `AgentRuntimeAdapter` and every contract dimension
- [ ] 2.2 Add Codex activation packaging wiring the baseline transport to the CLI verbs
- [ ] 2.3 Integration test driving Codex's real lifecycle-hook command strings and stdin/env payloads through boot, deliver, deregister
- [ ] 2.4 Parity test: claimed-not-acknowledged, lead-only projection, and urgency/lifecycle handling identical to the Claude adapter

## 3. Cursor adapter (G20)

- [ ] 3.1 Implement `libs/core/src/adapter/cursor.ts`, with an internal surface branch if the probe shows divergent CLI/IDE mechanisms
- [ ] 3.2 Add Cursor activation packaging
- [ ] 3.3 Integration test driving Cursor's real input contract end to end (each surface)
- [ ] 3.4 Parity test against the Claude adapter's delivery semantics

## 4. Cross-host checks

- [ ] 4.1 Test that agent-facing verbs and ephemeral-monitor declaration resolve session identity through each adapter
- [ ] 4.2 Test that disabling a host's richer transport leaves delivery complete via its baseline with no error

## 5. Release and docs

- [ ] 5.1 Regenerate the core API report (`pnpm --filter @agentmonitors/core run fix:api-report`) for new adapter exports
- [ ] 5.2 Add changesets for `@agentmonitors/core` and `@agentmonitors/cli`
- [ ] 5.3 Add Codex and Cursor setup pages to `apps/website`
- [ ] 5.4 Retire roadmap G19/G20 as each adapter ships
