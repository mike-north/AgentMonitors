# Spec Changelog

This file records clarifications, contradiction resolutions, and structural changes to the
Agent Monitors spec set in `docs/specs/`.

## Usage

- Add entries when ambiguity is resolved or the intended contract changes.
- Prefer short entries tied to the numbered doc affected.
- If implementation behavior and desired behavior differ, say so explicitly.

## 2026-06-11 — `command-poll` source specified as target (003 §11–§13); 003 examples migrated to `watch:` syntax

Issue #81's problem framing is resolved into a normative **target** design (PP7) in
[003](./003-source-plugins.md):

- **§11 `command-poll`** — the local-process sibling of `api-poll`. Field-level scope (`command`
  argv array, `cwd`, `env`, `timeout`, `key`, `interval`, `change-detection`), execution model
  (1 MiB stdout cap, SIGTERM→SIGKILL timeout), strategies (`text-diff` default / `json-diff` /
  `exit-code`), identity and stateful baseline mirroring `api-poll`, and transition-edge failure
  semantics (`ok ↔ failing` health observations; **nonzero exit with output is a result, not a
  failure**). #81's open questions are decided in-spec: argv-only (no shell form, ever);
  env = inherit + literal overrides, never persisted; v1 executes without acknowledgment (a
  `MONITOR.md` is workspace code, same trust class as `package.json` scripts) with a
  command-acknowledgment ledger designed as target (§11.6); `exit-code` stays first-class;
  `observe()`-only in v1.
- **§12 keyed-collection change detection** — generic `change-detection.collection` mode
  (`path`/`key`/`ignore-paths`) emitting per-object observations with
  `created`/`modified`/`descoped`; applies to `api-poll` and `command-poll`; separable.
- **§13 caller-held cursor protocol** — sketch-only target ({{state}} argv templating +
  `next-state` extraction), deliberately not scheduled; the mtime pre-gate and monitor-chaining
  alternatives are recorded as rejected (003 §11.8), adopting #81's reasoning.
- **Roadmap:** new items G8 (`command-poll`, P2) and G9 (keyed collections, P3) with proofs.
- **Migration cleanup:** 003's YAML examples and schema-generation description still used the
  pre-migration `source:`/`scope:` authoring syntax; all examples now use the current
  `watch: { type, … }` shape ([001 §3.1](./001-monitor-definition.md)) and §7.2 reflects the
  actual generated schema (`watch`/`urgency` required, `watch.type` enum + conditional config).
- Spec-only — no implementation or published-package behavior change, so no changeset.

## 2026-06-11 — Channel session binding re-verified; `CLAUDE_CODE_SESSION_ID` is observed-not-documented (006 §4.4)

Prompted by the just-merged session-lifecycle stdin fix (hooks read `session_id` from stdin, **not**
an env var): does the same "no session-id env var" trap apply to the channel server, which runs as an
**MCP server** rather than a hook? Verified it does **not**.

- **Confirmed: an MCP-server subprocess receives `CLAUDE_CODE_SESSION_ID`.** Re-confirmed live against
  Claude Code 2.1.160 (the variable is present in MCP/child-process environments and its value exactly
  equals the live session id), corroborating the 2026-05-31 `experiments/channel-probe` run on 2.1.157.
  So `agentmonitors channel serve` resolving its session via `process.env['CLAUDE_CODE_SESSION_ID']`
  (`apps/cli/src/commands/channel.ts`) is correct — **no code change**. The hooks/stdin trap does not
  transfer: a hook is a short-lived per-event command (session id arrives on stdin), whereas the
  channel server is a long-lived MCP subprocess that inherits Claude Code's process environment.
- **Doc-precision correction.** The previous §4.4 cited <https://code.claude.com/docs/en/mcp.md> in a
  way that implied all three signals are documented. They are not: the current MCP reference documents
  only `CLAUDE_PROJECT_DIR` and `roots/list`; it is **silent** on `CLAUDE_CODE_SESSION_ID`. §4.4 now
  marks the two workspace signals **documented** and the session-id signal **empirically observed but
  undocumented** (host-version-dependent), with workspace binding (§4.4 #2) as the documented-safe
  fallback. Added an explicit hooks-vs-MCP contrast citing <https://code.claude.com/docs/en/hooks.md>
  (hook session id = stdin `session_id`; documented hook env vars do not include it).
- Updated the §10 open-question note to record the 2.1.160 re-confirmation and the observed-not-
  contracted caveat. Docs-only; no published-package behavior change, no changeset.

## 2026-06-10 — Activation plugin via a colocated aipm marketplace; `channel-plugin/` folded in

Activation now ships as a single installable Claude Code plugin (`agentmonitors`) in a colocated
[aipm](https://www.npmjs.com/package/@ai-plugin-marketplace/cli) marketplace embedded in this repo
(`agent-plugins/`, with `aipm.repo.ts` relocating `pluginsRoot` off the package `plugins/` glob).
The plugin wires the host lifecycle to the already-built CLI verbs — `SessionStart` →
`agentmonitors session start` then `agentmonitors hook deliver`, `UserPromptSubmit` →
`agentmonitors hook deliver`, `SessionEnd` → `agentmonitors session end` — and bundles the channel
MCP and a `setup-monitors` skill. Install once; thereafter a project opts in with project-local
state (no reinstall per monitor). Documented in [006 §5.6](./006-agent-integration.md).

- **Folded + retired `channel-plugin/`.** The standalone root `channel-plugin/` is removed; its
  `.mcp.json` (server key `agentmonitors`, preserving the `<channel source="agentmonitors">` tag)
  now lives at `agent-plugins/agentmonitors/.mcp.json` inside the activation plugin. The 2026-06-01
  entry below remains as a historical record of the original standalone packaging.
- **`PreToolUse`/`Stop` deliberately unwired** (they ignore `additionalContext`); `PostToolUse` left
  as a documented future tunable (per-tool firing → too many daemon round-trips for v1).
- **Targets: `claude` only.** aipm v0.3.0 does not generate Codex hooks and only Claude Code has the
  channel transport, so a non-Claude target would ship no working delivery path.
- **Hooks authored as host-native `hooks/hooks.json`.** aipm v0.3.0's Claude hooks transform only
  models `PreToolUse`/`PostToolUse`/`Stop`/`UserPromptSubmit`, so the lifecycle events
  (`SessionStart`/`SessionEnd`) are authored directly as a Claude-native `hooks/hooks.json`
  referenced from the plugin manifest, rather than via aipm's YAML→JSON generation.
- CLI/plugin-content only — no published-package behavior change, so no changeset.

## 2026-06-10 — Correction: `hook deliver` reads stdin JSON; corrected event support; truncation marker

Supersedes the input/event-support details of the Plan D entry below after verifying against the
current Claude Code hooks docs (<https://code.claude.com/docs/en/hooks.md>). Three corrections:

- **Input is stdin JSON, not env vars.** Claude Code delivers hook input as a JSON object on stdin
  (`session_id`, `cwd`, `hook_event_name`, …). There is **no `CLAUDE_CODE_SESSION_ID` environment
  variable** — the prior `hook deliver` relied on one and would silently no-op in real sessions. The
  command now reads stdin (robust against a TTY/empty/unparseable stream — it never hangs), derives
  `sessionId = payload.session_id` (no env fallback), `hookEventName = payload.hook_event_name`, and
  `workspacePath = payload.cwd ?? CLAUDE_PROJECT_DIR ?? cwd`.
- **`additionalContext` is honored only by context events.** Per the docs, only `UserPromptSubmit`,
  `SessionStart`, and `PostToolUse` honor `hookSpecificOutput.additionalContext`; `PreToolUse` (uses
  `permissionDecision`) and `Stop` (uses a top-level `decision`) do **not**. The old default
  `--hook-event-name PreToolUse` therefore targeted an event that ignores the context. The
  `--hook-event-name` flag is **removed**; the lifecycle is now **derived** from `hook_event_name`
  (`UserPromptSubmit`/`PostToolUse` → `turn-interruptible`, `SessionStart` → `post-compact`; any
  other event → emit nothing). `--lifecycle` remains as an optional override (mainly for tests). One
  command line — `agentmonitors hook deliver` — now works for every registered event.
- **Code-point-safe truncation with an explicit marker.** When the rendered context exceeds the
  4000-char cap it is truncated at a Unicode code-point boundary (never splitting a surrogate pair)
  and an explicit `[truncated — … run "agentmonitors events list --unread" …]` marker is appended
  (final string still ≤ cap). Truncation does **not** lose events: claiming marks rows claimed, not
  acknowledged (`unreadEventsForSession` filters on `acknowledgedAt IS NULL` only), so a
  truncated-away event stays **unread** and re-delivers via the next context event.

Docs updated: [006 §5.0/§5.1/§5.2/§5.3/§5.4/§5.5](./006-agent-integration.md),
[005 §12.2](./005-cli-reference.md). Tests: stdin-driven `hook deliver` integration tests, a
truncation-recoverability integration test (truncated-away events still in `events list --unread`),
and renderer truncation-marker + surrogate-pair unit tests.

---

## 2026-06-09 — Package scope rename: `@mike-north/*` → `@agentmonitors/*`; public npm publish

All published packages now use the `@agentmonitors` npm scope published to public npm
(`https://registry.npmjs.org`), replacing the previous `@mike-north` GitHub Packages scope.
The CLI (`@agentmonitors/cli`) is now a publishable package (no longer `private: true`); the
canonical install is `npm install -g @agentmonitors/cli`.

Packages renamed:

- `@mike-north/core` → `@agentmonitors/core`
- `@mike-north/source-file-fingerprint` → `@agentmonitors/source-file-fingerprint`
- `@mike-north/source-api-poll` → `@agentmonitors/source-api-poll`
- `@mike-north/source-schedule` → `@agentmonitors/source-schedule`
- `@mike-north/source-incoming-changes` → `@agentmonitors/source-incoming-changes`
- `@mike-north/cli` → `@agentmonitors/cli`
- `@mike-north/website` → `@agentmonitors/website`

Release pipeline: `release.yml` now uses `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` (repo
owner must add the `NPM_TOKEN` secret). Changeset `access` set to `"public"`.

No spec behavior changes. All package references in docs, source files, and tooling updated.

---

## 2026-06-10 — Plan D Tasks 2–3: hook-deliver renderer + `hook deliver` command

- Added `apps/cli/src/hook-deliver-render.ts` — a **pure, side-effect-free renderer** that maps a
  `DeliveryClaim` to the Claude Code hook wire shape
  `{ continue: true, hookSpecificOutput: { hookEventName, additionalContext } }`. Returns `null`
  when the claim is null or has no events. `additionalContext` is capped at 4000 characters; unlike
  the channel transport (§4.6), it is a plain JSON string that is **not** tag-delimited, so
  markdown/code punctuation (`<>`, `[]`, `;`) and newlines are preserved verbatim (a monitor body is
  trusted, user-authored markdown) — only raw C0/C1 control characters (except tab/newline) are
  stripped. The rendered context includes a lead line and one block per event: monitorId, urgency,
  title, and the monitor's `body`-instructions from `DeliveryEventSummary.body`.
- Added `hook deliver` subcommand to `apps/cli/src/commands/hook.ts`. Designed to run as a Claude
  Code lifecycle hook (`PreToolUse`, `Stop`, `PostCompact`). Reads `CLAUDE_CODE_SESSION_ID` +
  `CLAUDE_PROJECT_DIR` from env, resolves the daemon socket via `.local.md`, looks up the session,
  claims pending deliveries at the given `--lifecycle`, renders, and writes the wire JSON to stdout.
  **Always exits 0** — any internal error is swallowed (a hook that exits non-zero would interrupt
  the user's session). Prints nothing when there is nothing pending.
- [005 §12.2](./005-cli-reference.md) added (`hook deliver` command reference, flags, wire output,
  always-exit-0 contract).
- [006 §5](./006-agent-integration.md) added (hook-deliver transport spec: wire contract, behavior
  steps, lifecycle-to-delivery mapping, and hook registration examples).
- `.changeset/hook-deliver-command.md`: `@agentmonitors/cli` minor (new `hook deliver` command).

---

## 2026-06-09 — Plan D Task 1: `DeliveryEventSummary` carries the monitor `body`

- A new required field `body: string` is added to `DeliveryEventSummary`
  (`libs/core/src/runtime/types.ts`). It carries the raw monitor body-instructions
  (`MonitorEventRecord.body`, set from `observation.body ?? monitor.instructions`), so a delivery
  transport can surface what the agent should **do** when a monitor fires — not just the
  `title`/`summary`.
- `claimDelivery()` in `service.ts` populates `body: event.body` in both places that map events to
  `DeliveryEventSummary`: the settled-high (`turn-interruptible`) path and the recap
  (`post-compact`) path. The `normal` and `low` paths return `events: []` and are unaffected.
- `DeliveryEventSummary` is re-exported from the public index; the api-extractor rollup
  (`dist/public.d.ts`) is updated to include the new field.
- [002 §9.1](./002-runtime-delivery.md) and [002 §9.4](./002-runtime-delivery.md) updated to
  document the `body` field. [006](./006-agent-integration.md) updated to reflect the enrichment.

## 2026-06-09 — Lazy project-scoped daemon (Plan B)

CLI-only change (no `@agentmonitors/core` public API change; no changeset needed).

**New files:**

- `apps/cli/src/workspace-paths.ts` — `workspacePaths(workspacePath)` derives a stable per-workspace
  `{ dir, db, socket }` under `XDG_DATA_HOME ?? ~/.local/share/agentmonitors/workspaces/<hash>/`.
- `apps/cli/src/local-state.ts` — `readLocalState`/`writeLocalState` for
  `.claude/agentmonitors.local.md` (minimal YAML frontmatter: `enabled`, `socket`, `db`,
  `reap-after-ms`). Absent/unparseable → `{ enabled: false }` (quick-exit).
- `apps/cli/src/detached-spawn.ts` — `spawnDetachedDaemon()` spawns `daemon run` with
  `detached: true, stdio: 'ignore'`, `.unref()`. The spawner exits; the daemon runs in the background.

**Modified files:**

- `apps/cli/src/commands/session.ts` — adds `session start` (lazy-boot daemon + `session.open`) and
  `session end` (finds session by `hostSessionId`, calls `session.close`). Both are no-ops when
  `CLAUDE_CODE_SESSION_ID` is absent or `enabled: false`.
- `apps/cli/src/commands/daemon.ts` — adds `--reap-after-ms <ms>` to `daemon run` (default 300000;
  0 disables). After each tick, the daemon counts active sessions for the workspace; if zero for
  `reapAfterMs` ms continuously, it stops itself.

**Spec updates:**

- [002 §10.2](./002-runtime-delivery.md#102-daemon-run--continuous-loop--unix-socket-server) — lazy
  boot, per-workspace isolation, idle reaping.
- [005 §9.2](./005-cli-reference.md#92-daemon-run--continuous-loop), [§10.4](./005-cli-reference.md#104-session-start--lazy-boot-daemon-and-register-session),
  [§10.5](./005-cli-reference.md#105-session-end--deregister-session) — `session start`/`session end` + `--reap-after-ms`.

## 2026-06-09 — `rebaselined` observation outcome and `ObservationResult.outcome` diagnostic

- A new optional field `outcome?: 'rebaselined'` is added to `ObservationResult`
  (`libs/core/src/observation/types.ts`). A source can set this to signal that it advanced its
  persisted baseline to the current point but could not compute a delta (e.g. a gc'd or
  force-pushed prior ref), as opposed to a genuine quiet tick.
- A new `ObservationOutcome` member `'rebaselined'` is added to the union in
  `libs/core/src/runtime/types.ts` and to the drizzle enum in `libs/core/src/inbox/schema.ts`.
- `ingest()` in `service.ts` maps `sourceOutcome: 'rebaselined'` to the new history result, with
  correct precedence: emitted > 0 → `triggered`; else if `rebaselined` → `rebaselined`; else
  observed > 0 → `suppressed`; else → `no-change`.
- The `incoming-changes` source (`plugins/source-incoming-changes`) now sets `outcome: 'rebaselined'`
  on the diff-failure re-baseline path (the `entries === undefined` branch). The other early-return
  paths (not-a-repo, initial baseline, genuine no-advance) are left unchanged.
- `agentmonitors monitor history` help text updated to include `rebaselined` in the result legend.
- [002 §`observation_history`](./002-runtime-delivery.md) and [005 §6](./005-cli-reference.md) updated.
- Issue: [#56](https://github.com/mike-north/AgentMonitors/issues/56).

## 2026-06-08 — Authoring surface → `watch: { type }` (closes #41)

Replace the mechanism-first `source:` + `scope:` frontmatter pair with an
intent-first `watch:` block carrying an explicit `type` discriminator. This is a
**hard cut** — the old `source:`/`scope:` shape no longer validates.

### New canonical shape

```yaml
name: ...               # optional, unchanged
watch:
  type: <source-name>   # e.g. file-fingerprint, api-poll, schedule, incoming-changes
  <...per-source config flat here...>
urgency: normal         # unchanged
notify: {...}           # optional, unchanged
tags: [...]             # optional, unchanged
```

Per-source config keys (including `interval`) live **flat inside `watch:`** as
siblings of `type`. There is no nested `scope:` object.

### Files changed

- `libs/core/src/schema/monitor-schema.ts`: replaced `source` (string) + `scope`
  (record) with `watch` (object with validated `type` + `.catchall(z.unknown())`
  for per-source config).
- `libs/core/src/runtime/service.ts`: all `frontmatter.source` → `frontmatter.watch.type`;
  all `frontmatter.scope` → `watchConfig(frontmatter.watch)` (helper that returns the
  `watch` block minus `type`).
- `libs/core/src/schema/validate-scope.ts`: unchanged — callers now pass the watch config
  object (watch minus type) instead of `scope`.
- `libs/core/src/observation/schema-generator.ts`: updated to discriminate on
  `watch.type` instead of `source`; required fields are now `['watch', 'urgency']`.
- `apps/cli/src/commands/init.ts`: all templates rewritten to `watch:` shape; `--source`
  option renamed to `--type`.
- `apps/cli/src/commands/validate.ts`, `scan.ts`, `monitor-test.ts`: updated to read
  `frontmatter.watch.type` instead of `frontmatter.source` and pass watch config to
  `validateScope`.
- `.claude/monitors/spec-changes/MONITOR.md`: dogfood monitor converted to `watch:` shape.
- All test fixtures in `libs/core/src/` and `apps/cli/src/` updated.
- `docs/specs/001-monitor-definition.md` §3 updated to document `watch:` block.

### api-extractor

`monitorFrontmatterSchema` and `MonitorFrontmatter` public API changed; report
regenerated.

## 2026-06-08 — Reconcile `changeKind` vocabulary (closes #42)

The `changeKind` vocabulary is now canonical across the standard and the codebase. The
four values `created | modified | deleted | descoped` were already the implementation
contract in `libs/core/src/observation/types.ts`; this entry records the corresponding
update to the outward standard.

- `docs/standard/monitor-md-standard.md` §2: replaced the five-row table (which listed
  `appeared` and `elapsed`) with the four canonical values; folded "a new member of a
  collection/feed appeared" into the `created` row; removed the "being reconciled"
  caveat blockquote (the vocabularies now agree).
- `libs/core/src/observation/types.ts`: rewrote the `ChangeKind` doc-comment to make
  `created` and `descoped` crisply distinct. `created` = a new object or member entered
  the monitor's scope (including new items in a watched collection/feed); `descoped` =
  still exists upstream but left the monitor's scope (no information lost).
- No runtime behavior change — the type was already `created | modified | deleted | descoped`.

## 2026-06-08 — Per-monitor `observe()` failure isolation and `errored` outcome

- The runtime now **isolates per-monitor failures in `tick()`**: if a source's `observe()` throws
  or rejects, the failure is caught, an `errored` observation-history row is recorded, and the tick
  continues to the next due monitor. A single buggy source can no longer abort the entire tick and
  starve all other monitors ([002 §`observation_history`](./002-runtime-delivery.md)).
- The same isolation is applied to the **watch path** (`consumeWatch()`): an `ingest()` failure on
  one yielded observation records an `errored` history row and the watcher continues consuming
  subsequent observations. The outer catch (for errors from the async iterator itself) is unchanged.
- **State preservation on failure**: `ingest()` is not called for a failing monitor, which means
  `setMonitorState()` is never reached. The persisted `sourceState` is left exactly as it was after
  the last successful tick, so the next tick's diff spans from the last good baseline rather than
  from an empty state — no subsequent delta is dropped.
- **New `ObservationOutcome` member**: `'errored'` is added to the
  `ObservationOutcome` union (`libs/core/src/runtime/types.ts`) and the drizzle enum in
  `libs/core/src/inbox/schema.ts`. The raw SQL in `libs/core/src/inbox/db.ts` uses `result TEXT NOT
NULL` with no CHECK constraint and needed no change.
- Minor `@agentmonitors/core` changeset (new public `ObservationOutcome` member + runtime guarantee).
- Issue: [#46](https://github.com/mike-north/AgentMonitors/issues/46).

## 2026-06-08 — New bundled source `incoming-changes`

- Added `@agentmonitors/source-incoming-changes` as the fourth bundled observation source
  ([003 §6](./003-source-plugins.md)). The source detects per-file changes when a git ref advances
  (pull, merge, fast-forward, or local commit) and reports them as `Observation` records with a
  `changeKind` (`created`/`modified`/`deleted`), `objectKey` (file path), `snapshotText` (new text
  content for created/modified non-binary files), and `payload: { path, status, fromRef, toRef }`.
- **Resumption token** = last-seen commit SHA (`nextState: { ref: '<sha>' }`). Restart-safe: on wake
  the diff spans `<stored-sha>..<current-head>` — the net change across all missed commits is
  reported in one batch (PP6).
- **v1 scope boundary**: fires on any ref advance touching `paths`; "fetch-only" filtering is a
  planned later refinement.
- **Error resilience**: `rev-parse` failures return an empty result with no `nextState`; `git diff`
  failures (gc'd SHA, history-rewritten range) trigger a silent re-baseline. Neither propagates to
  the tick loop.
- CLI registration and `init` scaffolding land with issue #39.
- Minor `@agentmonitors/source-incoming-changes` changeset (initial `minor`).

## 2026-06-07 — Remove `event-kind` frontmatter field

- `event-kind` (and its runtime counterparts `eventKind` / `event_kind`) are **removed** from the
  schema and the entire pipeline. The field was never surfaced in a delivered signal and served no
  runtime purpose. Affected: frontmatter schema ([001 §3](./001-monitor-definition.md)), required
  fields for JSON Schema generation ([003 §2](./003-source-plugins.md)), `monitor_events` and
  `inbox_items` DB columns ([002 §5/§12](./002-runtime-delivery.md)), delivery meta key table
  ([006 §4.2](./006-agent-integration.md)), CLI scan output and filter options
  ([005 §5/§9](./005-cli-reference.md)). No DB migration — a local no-users project. Minor
  `@agentmonitors/core` changeset.

## 2026-06-04 — Flat-file monitor authoring; `name` optional

- Monitors may now be authored as a flat `.claude/monitors/<id>.md` file (id = filename), in
  addition to the folder form `<id>/MONITOR.md` (id = directory). The scanner discovers both;
  markdown assets nested inside a folder monitor are not treated as monitors
  ([001 §scanning](./001-monitor-definition.md)). Verified: `parse-monitor.ts` id derivation and
  `scan-monitors.ts` combined glob.
- `name` is now **optional** in frontmatter and defaults to the monitor id. Minor
  `@agentmonitors/core` changeset.

## 2026-06-02 — Channel transport, automated end-to-end UAT

- Added `experiments/channel-uat/` — an MCP-client harness that verifies the channel **push** path
  ([006 §4](./006-agent-integration.md)) end to end without a live Claude session or a
  channels-enabled org. It starts a real daemon + monitor, spawns `agentmonitors channel serve`,
  connects to it over stdio as the MCP host (injecting `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PROJECT_DIR`
  exactly as Claude Code would), mutates the watched file, and asserts the `<channel>` push.
- Confirmed both delivery shapes: `normal` urgency pushes the coalesced reminder; `high` urgency
  pushes the concrete event (`event_count: 1`, `monitor_id`, `event_id`) after the ~15s settle.
- Retires the last G7 follow-up (the previously "manual, not CI-able" end-to-end UAT). Experiment-only
  (outside the workspace globs); no changeset.

## 2026-06-02 — Watch-mode source execution (G5)

- The runtime now drives continuous `watch()` for opt-in sources:
  `AgentMonitorRuntime.watchMonitors(monitorsDir, workspacePath)` consumes each watch-capable
  source's `AsyncIterable<Observation>` and funnels every yielded observation through the **same**
  notify dispatch → materialization → projection pipeline as `observe()` (extracted into a shared
  `ingest()` helper, which also records the `observation_history` audit row, so watch-mode
  observations are audited identically to ticked ones). Returns a `WatchHandle` whose `stop()` aborts
  and awaits the watchers ([002 §2.3](./002-runtime-delivery.md)). `daemon run` starts/stops watchers
  around its tick loop.
- A watched monitor is skipped by the tick loop's `observe()` (no double-processing); a watcher that
  throws outside its own abort is surfaced via `onError` and released so the tick loop resumes it.
- Added `ObservationContext.signal?: AbortSignal` (passed to `watch()` for teardown) and the exported
  `WatchHandle` type. Promoted **NP4** from "the runtime does not define watch-mode" to
  "watch-mode is opt-in and additive" ([000](./000-principles.md), [003 §2](./003-source-plugins.md)).
- Closes roadmap **G5**. No bundled source opts into `watch()` yet, but the path is exercised
  end-to-end (`libs/core/src/runtime/service.test.ts`). Minor `@agentmonitors/core` changeset
  (new `watchMonitors` method, `WatchHandle` type, `ObservationContext.signal` field).

## 2026-06-01 — Observation history audit trail (G6)

- The runtime now **writes `observation_history`** — for each due monitor per tick it records the
  outcome (`triggered` / `suppressed` / `no-change`) plus a `{ observed, emitted }` summary, via the
  new `RuntimeStore.recordObservationHistory` / `listObservationHistory`
  ([002 §"Persistence Schema"](./002-runtime-delivery.md)).
- Added a daemon IPC method `history.list` and the `agentmonitors monitor history [monitorId]`
  command to read it ([005 §6](./005-cli-reference.md)) — a "why didn't my monitor fire?" diagnostic.
- Closes roadmap **G6** (the dead table now has a write path **and** a reader). Runtime + CLI
  integration tests added; minor `@agentmonitors/core` changeset (new `RuntimeStore` methods, exported
  `ObservationHistoryRecord` / `ObservationHistoryQuery` / `ObservationOutcome` types, runtime write).

## 2026-06-01 — Channel transport, stage 3 (plugin packaging); G7 shipped

- Added `channel-plugin/` — a Claude Code channel plugin (`.claude-plugin/plugin.json` + `.mcp.json`)
  that runs `agentmonitors channel serve`, plus a README with the prerequisites and the manual UAT
  command. Lives at the repo root (outside the `plugins/*` workspace glob, since it is a plugin
  manifest, not an npm package).
- Marks the channel transport ([006 §4](./006-agent-integration.md)) implemented and retires roadmap
  **G7**. Non-blocking follow-ups remain: the end-to-end manual UAT (channels are research-preview)
  and optional `object_key` meta (needs `DeliveryEventSummary` enrichment).

## 2026-06-01 — Channel transport, stage 2 (two-way ack)

- `agentmonitors channel serve` is now two-way: it declares `capabilities.tools` and exposes the
  **`agentmon_ack`** tool (`apps/cli/src/channel-ack.ts`), which routes through `events.ack` for the
  bound session — the bound session id is the "outbound gate" (006 §4.3). Tool arguments are
  validated defensively at the MCP boundary (`parseAckArgs`, unit-tested). Session resolution is
  shared between the poll loop and the ack tool. Marked [006 §4.3](./006-agent-integration.md)
  implemented; updated roadmap G7 (remaining: plugin packaging + manual UAT). CLI-only; no changeset.

## 2026-06-01 — Channel transport, stage 1 (one-way push)

- Shipped `agentmonitors channel serve` ([005 §13](./005-cli-reference.md)): an MCP **channel**
  server that binds via `CLAUDE_CODE_SESSION_ID`, polls `claimDelivery('turn-interruptible')` over
  the daemon socket, and pushes each settled claim as a `<channel>` event. Reuses the claim path, so
  claimed-state and cross-transport dedup come for free; a missing daemon is handled quietly (the
  hook path still delivers). The claim→event renderer is unit-tested.
- Clarified [006 §2](./006-agent-integration.md): the transport seam needs **no in-process
  `DeliveryTransport` refactor** — the channel transport is realized out-of-process over the daemon
  IPC surface. Marked [006 §4.1](./006-agent-integration.md) one-way push as implemented; updated
  roadmap G7 (stage 1 done; remaining: ack tool + packaging + manual UAT).
- `apps/cli` is changeset-exempt, so no changeset. Also corrected a stale `validate` status in the
  005 command inventory (full schema validation since G2).

## 2026-06-01 — Closed remaining test gaps (T2, T4; T1 retired)

- **T2** — added `RuntimeStore` snapshot tests (save/retrieve + isolation by
  `(workspace, monitor, objectKey)`, SP5) and a runtime test asserting `diffText` is computed
  against the prior snapshot when an object changes.
- **T4** — added standalone CLI integration tests for `schema generate` (and `-o` output) and the
  `session list` → `session close` lifecycle.
- Retired the already-shipped **T1** (`low` urgency, #21) from the roadmap; all tracked test gaps
  (T1–T4) are now closed. Test-only change — no changeset.

## 2026-06-01 — First-class observation change-kind; file-fingerprint create/delete (G3)

- Introduced a **source-agnostic `changeKind`** primitive on the core `Observation` contract
  (`created` / `modified` / `deleted` / `descoped`), exported as the `ChangeKind` type. `deleted`
  (information lost upstream) and `descoped` (still exists upstream, left the monitor's scope) are
  deliberately distinct so agents react differently — e.g. a pull request _deleted_ vs _closed_.
  See [003 §2.3](./003-source-plugins.md).
- The runtime copies `observation.changeKind` into the materialized event's `queryScope.changeKind`
  ([002 §5.1](./002-runtime-delivery.md)), so it is filterable without each source duplicating it.
- `file-fingerprint` is the first emitter: it now reports `created` / `modified` / `deleted` /
  `descoped` (stat-ing the path to distinguish a true disk deletion from a glob/config change),
  closing roadmap G3 — promoted [003 §3.3](./003-source-plugins.md) from limitation to current
  behavior. Minor changesets for `@agentmonitors/core` and `@agentmonitors/source-file-fingerprint`.

## 2026-05-31 — Channel transport binding confirmed (006 §4.4)

- Ran the `experiments/channel-probe` diagnostic against Claude Code 2.1.157 with the probe spawned
  **as an MCP server** (`--mcp-config`). Confirmed: the server receives `CLAUDE_PROJECT_DIR`
  (= workspace), its cwd is the workspace, it **inherits `CLAUDE_CODE_SESSION_ID`**, and `roots/list`
  returns the workspace root.
- Resolved the [006 §4.4](./006-agent-integration.md) open question: **session-level binding is
  available** (the MCP subprocess inherits the host session id), so it is now the documented
  preferred strategy, with workspace binding as fallback. Updated roadmap G7 (binding proof done;
  remaining work is the transport seam + channel server). The channel transport itself is still
  target (unbuilt); only the binding mechanism is confirmed.

## 2026-05-31 — Full per-source scope validation in `validate` (G2)

- Promoted [004 §2.2](./004-validation-testing.md) and [001 §8](./001-monitor-definition.md)
  from target to **current**: `validate` now performs full JSON Schema (draft-07) validation of
  each monitor's `scope` against its source's `scopeSchema`, not just required-field presence.
  Closes roadmap G2 (and test gap T3).
- Added the exported core helper `validateScope(scope, scopeSchema)`
  (`libs/core/src/schema/validate-scope.ts`); the CLI calls it (AP4/AP6).
- Validator is **`@cfworker/json-schema`**, chosen over ajv specifically because it validates by
  walking the schema at runtime rather than compiling with the `Function` constructor — safe under
  restrictive CSP / Workers-style environments. Minor `@agentmonitors/core` changeset.

## 2026-05-31 — Duplicate monitor IDs are now rejected (G1)

- Promoted [001 §4](./001-monitor-definition.md) from target to **current**: duplicate
  folder-derived monitor IDs are now a hard error, closing roadmap item G1.
- `scanMonitors` surfaces collisions via a new `ScanResult.duplicateIds`
  (`DuplicateMonitorId[]`) field; the runtime tick refuses to run on duplicates; `validate`
  exits non-zero and `scan` reports them. Enforces SP2. Regression tests added at the scanner,
  runtime, and CLI layers; minor `@agentmonitors/core` changeset included.

## 2026-05-31 — Agent integration & delivery transports

- Added normative [006-agent-integration.md](./006-agent-integration.md): a delivery-**transport**
  abstraction behind the adapter seam, covering the current hook-state transport and a **target**
  Claude Code **channel** transport. Recorded as roadmap item G7.
- Scoped the channel transport's binding model from evidence. A spawned MCP server can recover its
  **workspace** (`CLAUDE_PROJECT_DIR` / MCP `roots/list`). For **session** identity there is no
  `CLAUDE_SESSION_ID`, but a probe found `CLAUDE_CODE_SESSION_ID` present in Claude Code's process
  environment; whether MCP-server subprocesses inherit it is the open question the one-way prototype
  (`experiments/channel-probe/`) resolves. Binding therefore prefers **session** scope when that
  variable is available and falls back to **workspace** scope (single-active-lead-session assumption,
  degrade on multi-lead); the hook-state transport remains the per-session-accurate surface either way.
- Established that channels are **optional and additive** (NP-CH): research-preview, version- and
  org-gated, so they must never become a delivery dependency. The hook-state transport stays the
  always-available default.

## 2026-05-31 — In-repo authoring pass

The numbered draft set was promoted into `docs/specs/` as the
canonical contract, verified against the code, and enriched. See
[maintainer-migration-notes.md](./maintainer-migration-notes.md) for the source mapping.

### Structure

- Established `docs/specs/` as the canonical location (previously only referenced as a plan).
- Added supporting docs: [README.md](./README.md), [glossary.md](./glossary.md),
  [roadmap.md](./roadmap.md).
- Added normative [005-cli-reference.md](./005-cli-reference.md) covering the full
  `agentmonitors` command surface.

### 001-monitor-definition.md

- Verified the `source` field constraint against `monitor-schema.ts`: the regex is
  `^[a-z][a-z0-9-]*$` (first character must be a lowercase letter), which is stricter than
  the prose "kebab-case". The doc now states the exact regex.

### 002-runtime-delivery.md

- Enriched with verified sections for the **daemon/IPC** layer, **agent-integration
  adapters** (`claudeCodeAdapter` lifecycle→hook mapping), and a **persistence-schema
  appendix** covering the real Drizzle/SQLite tables.
- Clarified that `daemon once` / a single tick runs **in-process without the Unix socket**;
  only `daemon run` serves the socket that `session`/`events`/`hook` round-trip through.
- Clarified that lead-only event projection is enforced as a post-query role filter, that
  `latestHighTitles` is capped at 5, and that computed diffs are capped at 20 changed lines.
- Recorded that `observation_history` is defined in the schema but has **no runtime write
  path** (current-vs-target; tracked as roadmap G6).

### 003-source-plugins.md

- Verified `api-poll` is **stateful**, that `text-diff` is its **default** change-detection
  strategy, that its `method` scope enum is limited to `GET`/`POST`, and that its
  `snapshot` carries `{ url, status, bodyLength, strategy }` rather than the full body.
- Clarified that `schedule` omits the `stateful` field entirely (rather than setting it
  `false`), and that `queryScope` values may be `string | string[]`.

### 004-validation-testing.md

- Replaced the external "FormSpec" style reference (from the source author's other project)
  with project-local guidance, since FormSpec does not exist in this repo.
- Mapped each required test scenario to the test file that covers it and flagged the
  uncovered ones (`low` urgency, snapshot persistence/isolation, `validate` failure paths,
  `schema generate` and standalone `session list|close` wiring). Tracked in
  [roadmap.md](./roadmap.md) as T1–T4.

### Carried forward from the prior draft set (2026-04-06)

- **000-principles.md** — established the numbered spec set as the canonical implementation
  contract; recorded the runtime/session event pipeline as authoritative delivery; recorded
  the legacy inbox lifecycle as a separate still-implemented model; made `low` urgency
  first-class.
- **001-monitor-definition.md** — split monitor authoring/frontmatter into its own doc; made
  duplicate monitor IDs a normative correctness requirement even though the scanner does not
  yet reject them; clarified single-root (no multi-root merge) evaluation.
- **002-runtime-delivery.md** — split runtime polling, persistence, session projection, and
  hook delivery into a dedicated contract; clarified unread/claimed/acknowledged as distinct;
  clarified that high urgency defaults to debounced delivery rather than immediate interrupt.
- **003-source-plugins.md** — split the source contract and bundled-source behavior into a
  dedicated doc; recorded `file-fingerprint` create/delete limitations; recorded
  plugin-management CLI commands as placeholders.
- **004-validation-testing.md** — clarified that `agentmonitors validate` performs partial
  source-specific validation rather than full per-source JSON Schema validation; defined the
  evidence hierarchy for resolving drift during the transition to the internal numbered specs.
