## 1. Dependency

- [ ] 1.1 Add `@parcel/watcher` to `@agentmonitors/source-file-fingerprint`; keep `pnpm check:dependency-audit` clean
- [ ] 1.2 Confirm prebuilt binaries resolve in `pnpm test:standalone-consumer` and `pnpm publish:packages:dry-run`

## 2. Scope

- [ ] 2.1 Add the optional `backend` field (`auto` | `fs-events` | `watchman` | `inotify` | `kqueue` | `windows`, default `auto`) to the `file-fingerprint` `scopeSchema` and config parsing
- [ ] 2.2 Schema-parity tests: each valid `backend` value accepted; an unknown value rejected; omitted defaults to `auto`

## 3. Watch implementation

- [ ] 3.1 Implement `watch()`: subscribe to the resolved `cwd` + `globs` + `ignore` tree; re-hash on events; yield observations with the same shape, change kinds, and salience as `observe()`; update in-memory state
- [ ] 3.2 Optional ~50–100 ms coalesce window for atomic saves
- [ ] 3.3 Close the subscription and stop yielding when `context.signal` aborts
- [ ] 3.4 Reconcile-on-start: load persisted baseline, run one `observe()` pass through ingest, seed in-memory state, then subscribe
- [ ] 3.5 Periodic `context.checkpoint` of fingerprint state at roughly `interval` (default 30s); log and continue on checkpoint failure

## 4. Backend failure policy

- [ ] 4.1 Under `auto`, fall back to `observe()` polling at `interval` on watcher-init failure and record a warning surfaced by `agentmonitors monitor explain`
- [ ] 4.2 For pinned backends, probe availability before delegating to `@parcel/watcher`; fail the monitor with `file-fingerprint: pinned backend '<name>' is not available on this system`, surfaced in `daemon once` / `daemon run` output and `monitor explain`

## 5. Tests

- [ ] 5.1 Unit: watcher yields `modified`/`created`/`deleted` (with `salience: 'high'`) observations matching `observe()`'s shape for the same file transitions
- [ ] 5.2 Unit (fake timers): atomic write-then-rename within the coalesce window yields one `modified` observation
- [ ] 5.3 Unit: aborting `context.signal` closes the subscription and ends iteration
- [ ] 5.4 Integration: stop daemon, modify `foo.ts` and delete `bar.ts`, restart → reconcile emits `modified` for `foo.ts` and `deleted` for `bar.ts` before any OS-level event
- [ ] 5.5 Integration: start watcher, yield + checkpoint changes, simulate crash before the next checkpoint, restart → reconcile reports only post-checkpoint changes
- [ ] 5.6 Integration: `backend: watchman` with Watchman unavailable → monitor-level failure, no polling fallback
- [ ] 5.7 Integration: `backend: auto` with init forced to fail → monitor polls and `monitor explain` shows the warning
- [ ] 5.8 Integration: `daemon once` calls `observe()` and opens no watcher; tick loop skips `observe()` while a watcher is active

## 6. Release collateral

- [ ] 6.1 Add a changeset for `@agentmonitors/source-file-fingerprint` (and `@agentmonitors/cli` if `monitor explain` output changes)
- [ ] 6.2 Regenerate API reports if a public surface changes (`pnpm --filter <pkg> run fix:api-report`)
- [ ] 6.3 Update `apps/website` `file-fingerprint` docs (watch mode, `backend`, fallback behavior, `interval` semantics)
