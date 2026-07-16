# @agentmonitors/cli

## 0.9.0

### Minor Changes

- a7b5729: Add ephemeral (agent-declared, session-scoped) monitors — the `agentmonitors watch` verb (spec 007
  §4 / 005 §14.4).

  An agent can now declare a session-scoped monitor at runtime — "tell me when _X_, and remind me of
  _this instruction_ when it does" — without authoring a `MONITOR.md` file:
  - `agentmonitors watch <source> --session <id> --scope <spec> [--urgency] [--instruction]` declares
    one; `watch list --session <id>` and `watch cancel <ephemeralId> --session <id>` manage them.
    `--scope` accepts `key=value,...` or a JSON object.
  - Ephemeral monitors flow the **same** daemon pipeline as persistent monitors (AP7):
    tick → notify → materialize → project → deliver. Their scope is validated by the **same** shared
    `validateWatchScope` path as `agentmonitors validate` (schema check plus the BP3
    `change-detection.collection` friendly wrapper), so an invalid scope is rejected with the identical
    diagnosis and they cannot express a config a persistent monitor could not.
  - **Binding:** a declaration must bind to a **lead** session; because projection is lead-only, a
    binding to a subagent session (which could never deliver) is rejected at declaration time.
  - **Projection isolation:** an ephemeral monitor's events project into the **declaring session
    only**, never a sibling lead session in the same workspace — and its private free-text instruction
    is never surfaced by an **unscoped** (session-less) read (`events list` without `--session`, or the
    unscoped observation-history enumeration); it is readable only through the declaring session's
    session-scoped read.
  - **Reap safety:** a `watch cancel` (or session close/dormancy) that races an in-flight tick never
    delivers for the reaped watch — delivery re-checks, at materialization time, that the monitor and
    its declaring session are still active; otherwise the observed event is retained but projected to
    nobody.
  - **Lifecycle:** active on declaration; reaped on session close, on `watch cancel`, and on a new
    per-session dormancy trigger (a session inactive past `DEFAULT_SESSION_DORMANCY_MS`). The
    definition and its durable state survive a daemon restart while the session lives, and a reaped
    monitor is never resurrected after the session ends. Already-materialized events are retained.
  - Ephemeral ids are the reserved-prefix form `ephemeral:<sessionId>/<ulid>`, structurally unable to
    collide with a directory-derived persistent monitor id.

  Public core surface: `AgentMonitorRuntime` gains `declareEphemeralMonitor`, `listEphemeralMonitors`,
  and `cancelEphemeralMonitor`, plus the exported `EphemeralMonitorRecord`, `EphemeralMonitorStatus`,
  and `DeclareEphemeralMonitorInput` types and an optional `sessionDormancyMs` constructor option. The
  scope-validation helpers `validateWatchScope` and `changeDetectionCollectionError` are exported so
  the CLI and the ephemeral declare path share one validation path.

- cf4352d: `init --type command-poll` now accepts a `--command` seed flag, and `validate` warns when a
  command-poll scaffold is left at its untouched default.

  Previously `init <name> --type command-poll` always scaffolded the fixed default command
  `git ls-remote origin refs/heads/main`, regardless of intent. Because that default validates and
  runs, a scaffold left untouched silently watched the wrong thing for any other goal (e.g. watching
  uncommitted changes with `git status --porcelain`) instead of failing visibly.
  - **New `--command` seed flag** (scaffold form only, mirroring `--glob`): repeatable, seeding
    `watch.command` one argv token per flag, order-preserving — `init dirty-worktree --type
command-poll --command git --command status --command --porcelain` yields
    `command: [git, status, --porcelain]`. Each token round-trips verbatim (single-quoted YAML), and
    the CLI never whitespace-splits, so it never invents shell semantics the source doesn't have. It
    is rejected with a clear error for any `--type` other than `command-poll`.
  - **Untouched-default warning:** when `--command` is omitted, the scaffold keeps its illustrative
    upstream-tip default, but `agentmonitors validate` now emits a soft, non-fatal warning for a
    command-poll monitor whose `watch.command` still equals that exact default — so a wrong-intent
    ship is caught instead of silently passing as configured. The warning does not change the
    valid/invalid counts or the exit code. `validate --format json` gains an additive
    `warnings: [{ id, warning }]` array (`[]` when none), and text output gains an optional
    `Warnings:` section.

- 89e705f: Add a first-class `agentmonitors verify [monitor]` command that proves a monitor delivers
  end-to-end in one shot, replacing the fragile manual "prove it, right now" recipe (a custom
  `--socket`, a scratch `AGENTMONITORS_DB`, a backgrounded daemon with `trap` cleanup, hand-built hook
  JSON payloads, two poll loops, and two session-id concepts).

  `verify` boots and supervises an **isolated** daemon (temp socket + db, reaping disabled), registers
  a throwaway lead session, triggers a **real** change (an auto scratch-file for file-fingerprint
  pattern globs, a restored-on-exit edit for a literal glob, or `--manual` watch mode for sources it
  can't fabricate a change for), then polls with a budget **derived from the monitor's own interval +
  notify settle (+ the 15s high-urgency claim-settle) + margin** — not a fixed 40s — printing
  elapsed/ETA progress to stderr. Those interval/settle defaults come from the runtime's canonical
  `schedulingDefaults` export in `@agentmonitors/core`, so the budget can't drift from what the daemon
  actually schedules. It interprets the observation pipeline in plain language: a `triggered` outcome
  is success and a `no-files-matched` outcome fails fast, while a `no-change` outcome fails fast **only
  when the change isn't merely settling** — a `debounce`/`throttle` monitor holds the observed change
  (recorded as a `suppressed` row) and emits `triggered` at flush, so a `suppressed` row keeps the wait
  alive rather than being reported as its own outcome. A **dead daemon** fails fast with the daemon's
  own error instead of an ambiguous empty result. It confirms delivery through the real `hook deliver`
  claim path and prints one clean **PASS** (echoing the delivered `additionalContext`) or **FAIL**
  naming the failing stage. Non-zero exit only on a genuine failure. Everything it created is cleaned
  up on exit; `--use-workspace-daemon` instead targets and leaves running the real workspace daemon so
  a follow-up `agentmonitors doctor` reflects the delivery. `--format json` emits a stable machine
  shape; `--timeout-ms <ms>` overrides the detection budget.

- 4e46c41: Namespace persisted monitor runtime state and observation history by workspace (P1
  durable-state / workspace-isolation fix).

  `monitor_state` was keyed by `monitorId` alone (its PRIMARY KEY, with no workspace column), and
  `observation_history` had no workspace column. Because the database is global and the same monitor
  id can exist in unrelated workspaces on one machine — the getting-started default `my-first-monitor`
  is the common collision — a second project reusing the id read the first project's `file-fingerprint`
  baseline and reported `descoped`/`deleted` changes for files that only ever existed in the other
  workspace.
  - **State is now keyed by `(monitorId, workspacePath)`.** A surrogate `id` primary key plus a UNIQUE
    index on `(monitor_id, COALESCE(workspace_path, ''))` keeps each scope single-rowed, including the
    global (`NULL`) scope. `RuntimeStore.getMonitorState`/`setMonitorState` now take the workspace
    scope, and `recordObservationHistory` records it; `ObservationHistoryRecord`/`ObservationHistoryQuery`
    carry `workspacePath`.
  - **Scoped diagnostics.** `monitor explain` and `doctor` scope observation history to their workspace;
    `agentmonitors monitor history` gains an opt-in `--workspace <path>` filter (unscoped still tails
    across all workspaces).
  - **Migration — one-time re-baseline.** A pre-namespacing `monitor_state` (keyed by `monitor_id`
    alone) is rebuilt under the surrogate `id` PK on the first daemon open after upgrade. Only
    `source_state` is reset — it cannot be safely attributed to a workspace — so every monitor
    re-baselines cleanly on its first post-upgrade tick (no spurious created/deleted/descoped events).
    The durable `notify_state` batch (`pendingDebounce`/`pendingRollup` — already-detected observations
    the runtime must redeliver) is preserved and attributed to its workspace, so no pending delivery is
    silently dropped. Legacy observation-history rows are migrated additively (they keep `NULL` and fall
    out of workspace-scoped queries). The rebuild runs in one immediate transaction so concurrent
    first-opens can't double-migrate.

### Patch Changes

- c8a3287: `channel serve` (the MCP server the `agentmonitors` plugin's `.mcp.json` spawns with no flags) now
  resolves the same per-workspace socket `session start` binds to for an **enabled** workspace,
  instead of the bare global default. Because `channel serve` is spawned automatically like a hook
  (never typed by hand), its precedence for this is deliberately different from `session`/`events`/
  `hook`/`daemon`: an explicit `--socket` still wins outright, but the enabled workspace's socket now
  wins over `AGENTMONITORS_SOCKET` too — a stale env var left over from a different workspace must
  never cross-connect the channel to that workspace's daemon. A not-enabled workspace is unaffected:
  it still falls back to `AGENTMONITORS_SOCKET`, then the global default.

  Previously, `channel serve` spawned exactly as the plugin spawns it — with no `--socket` flag —
  resolved a _different_ socket than the one a `session start`-lazy-booted daemon binds to for an
  enabled workspace, so the channel transport silently never delivered a push (issue #358). Hook-state
  delivery was unaffected.

- 33bfb25: `daemon run`'s idle-reaping check (the block that stops the daemon after a workspace has had no
  active sessions for the configured idle window) is now wrapped in the same log-and-continue error
  boundary the observation tick already had. Previously a transient error there — for example
  `runtime.listSessions()` hitting a brief schema-visibility gap right after a fresh database is
  created — escaped the run loop uncaught and terminated the whole daemon process, silently ending
  all monitoring for that workspace. It now logs `AgentMon reaping check failed: …` and continues to
  the next tick, matching the existing `AgentMon runtime tick failed: …` behavior. Genuine stop
  conditions (`daemon stop`, SIGINT/SIGTERM, and an actual idle-reap decision) are unaffected.
- fcafd58: Fix `agentmonitors doctor`'s `lead-session` remediation recommending a command that fails as printed.
  It previously suggested `agentmonitors session open --role lead --workspace <path>`, but `session
open`'s `--host-session-id` is a required option — so copy-pasting the hint failed immediately with
  `error: required option '--host-session-id' not specified`, and a manual/no-plugin CLI user has no
  meaningful value to supply for it. The remediation now points at `agentmonitors session start` — the
  flagless lazy-boot path that matches real usage (the `SessionStart` hook runs exactly this command):
  it boots the project daemon if needed and registers a lead session in one shot, and has no required
  options. For the manual case the hint prints the exact stdin payload `session start` reads, with a
  `manual-cli-session` placeholder, so the printed command runs verbatim.
- e3f020d: Fix `agentmonitors doctor` under-reporting a monitor's `last-observed`/`last-event`/delivery counts
  after a real delivery against a live daemon. `doctor` previously always read its per-monitor rollup
  in-process, even when a daemon was reachable; a separate reader connection opened against the same
  SQLite file as a live writer's connection can lag behind that writer's commits, freezing the rollup
  at a stale snapshot. `doctor` now prefers the live daemon's own connection (a new `doctor.report`
  socket RPC, mirroring `monitor explain`/`monitor history`) whenever one is reachable, falling back to
  the in-process read only when the daemon is unreachable.

  Also fixes `doctor` exiting non-zero for checks that are expected to fail when idle: `daemon-reachable`
  and `lead-session` now use a distinct `idle` status (glyph `◇`) instead of `fail` when no agent
  session is currently open, and `idle` no longer counts toward a non-zero exit code — only a genuine
  `fail` does. Text and JSON output report a new `idle` count alongside `passed`/`failed`/`skipped`.

- d519192: Fix a crash in `file-fingerprint` when a `watch.globs` pattern matches a directory entry.
  Globstar patterns like `docs/**` match the directory `docs/` itself, in addition to every file
  under it; the source previously tried to `fs.readFile` that directory entry and crashed with an
  unhandled `EISDIR`. Directory entries are now filtered out before fingerprinting, so `docs/**`
  behaves as "every file under `docs/`, recursively" and no longer crashes.

  `agentmonitors monitor test`'s "no files matched" message now names the configured `watch.globs`
  value, so authors can tell a genuinely bad glob apart from a glob that matched files with no
  changes since baseline.

- 2aeedcb: `hook deliver` now writes a one-line stderr diagnostic, unconditionally (not gated behind
  `--debug`), when the hook payload's `session_id` matches no tracked AgentMon session:

  ```
  hook deliver: no session registered for host session id "<id>"
  ```

  Previously an unresolvable `session_id` produced byte-empty stdout + exit 0 — identical to the
  _expected_ empty output during the ~15s high-urgency claim-settle window — leaving an operator no
  way to tell "will never resolve" from "still settling" without reaching for `--debug` (issue #329).
  Stdout and the exit code are unchanged in every case; every other quiet-return branch (disabled
  workspace, unreachable daemon, settle-window hold, nothing pending, …) remains silent by default,
  diagnosable via `hook deliver --debug`.

- 4cafb5f: Fixed two `agentmonitors init <name>` scaffold papercuts (issue #375):
  - When `--name` is omitted, the scaffolded `name:` frontmatter field now derives from the
    positional `<name>` argument (e.g. `watch-docs` → `Watch docs`) instead of surviving as the
    template's literal placeholder (`My monitor`, `Upstream branch monitor`, etc.) — a rushed author
    could otherwise commit a monitor that was never renamed. `--name` still overrides.
  - The `command-poll` scaffold's inline comment no longer warns that local commands "such as
    `git status`" can stay stale until a fetch — that caveat applies only to a local read of a
    remote-tracking ref (e.g. `git rev-parse origin/main`). The scaffold's own `git ls-remote`
    queries the remote live and is always current, and `git status --porcelain` is local
    working-tree state with no fetch lag either. The previous wording contradicted the `skill.md`
    authoring guide's own recommended minimal `command-poll` example (`git status --porcelain`),
    leaving a new author unsure which to trust.

- 4fe8e58: Fix `agentmonitors init`'s post-scaffold guidance recommending an unreachable resource. Both the
  named `init <name>` scaffold path and the bare `init`/`init --yes` bootstrap path previously named
  only the `setup-monitors` skill's "Verify It Fires" section as the "full fire-and-deliver recipe" — a
  dead end for a no-plugin/no-docs CLI user, who has no way to reach that skill. The guidance now
  recommends `agentmonitors verify <name> --dir <dir>` (appending `--manual` for any `--type` other
  than `file-fingerprint`, since `verify`'s auto-trigger today only fabricates a change for
  `watch.globs`-based sources) — a real, CLI-only command that proves the monitor delivers end-to-end
  in one shot. The `setup-monitors` skill reference is kept, but now clearly labeled as a
  Claude-Code-plugin-only supplement alongside `verify`, never the only pointer.
- 2fb1347: `monitor history` and `monitor explain` now auto-discover the same per-workspace daemon socket
  `doctor`, `daemon status`, and `session open` already do — flagless, from the current working
  directory. Previously they fell back to the bare global-default socket instead of
  `resolveManualDaemonSocketPath()`'s workspace-aware resolution, so a daemon already running for
  the workspace (e.g. lazily booted by a Claude Code session) was invisible to `monitor
history`/`monitor explain` unless `--socket` was passed explicitly — surfacing as a misleading "No
  daemon running and no persisted state to show" even while `doctor`/`daemon status` confirmed the
  daemon was live (issue #374).

  Their no-daemon in-process fallback now also reads the same workspace-resolved SQLite database
  `doctor` reads, instead of the bare global default. When genuinely nothing is reachable and
  nothing is persisted, an actionable remediation message is printed, worded according to whether the
  workspace is actually enabled — i.e. whether a workspace-scoped socket was really derived, or the
  probe fell through to the bare global default:

  ```
  No daemon running for this workspace and no persisted state to show. Start it with `agentmonitors
  daemon run` (or it starts automatically when a Claude Code session opens); if the daemon you want
  lives at a different socket, point at it with `--socket <path>`. Or use `agentmonitors monitor
  test <path>` for a one-shot check.
  ```

  ```
  No daemon running at the default socket and no persisted state to show. Start it with
  `agentmonitors daemon run`, enable this workspace so its socket is auto-discovered
  (`agentmonitors init --enable-only`), or point at the daemon you want with `--socket <path>`. Or
  use `agentmonitors monitor test <path>` for a one-shot check.
  ```

  `monitor history --workspace <path>` (an existing opt-in row filter) now also selects which
  workspace's daemon/db is reached, since the workspace whose history you're asking for is also the
  daemon you want to talk to. The per-workspace socket/db derivation itself and `--socket`'s
  explicit-override precedence are unchanged.

- 8638936: Persist local data owner-only (P1 security/privacy). Agent Monitors stores private snapshot, event,
  diff, and source-state data — plus hook state and an unauthenticated IPC socket — on the local
  machine, previously created with umask-derived default modes. On a multi-user host with permissive
  home/XDG directory modes, another local user could read the database or connect to the socket to
  inspect/claim/ack events or stop the daemon.
  - The SQLite database and its WAL/SHM sidecars, hook-state files, the startup-lock pid file, and the
    `.claude/agentmonitors.local.md` coordination file are now owner-only (`0600`); the per-workspace
    data directory, session directories, socket directory, and startup-lock directory are owner-only
    (`0700`); the Unix domain socket is chmod'd `0600` and lives inside an owner-only directory.
  - The long-socket-path fallback now binds inside an owner-only per-uid directory
    (`/tmp/agentmonitors-<uid>/…`) instead of a predictable `/tmp/agentmonitors-<hash>.sock` other
    local users could connect to. During an in-flight upgrade, clients keep talking to a pre-upgrade
    daemon still listening at the old path (detected by a liveness probe) rather than starting a second
    daemon on the same database; one daemon restart completes the move.
  - Tightening is best-effort: if an artifact exists but is owned by another user (e.g. a hook-state
    path aimed into a shared directory), permission tightening logs one warning and continues instead
    of failing the write or crashing the daemon.
  - **Migration:** existing world-readable artifacts from an earlier version are tightened on the next
    daemon start. Tightening is symlink-safe (it never `chmod`s through an attacker-controlled
    symlink) and never re-modes a user-chosen (`--socket`/`AGENTMONITORS_SOCKET`) or shared system
    socket directory.
  - POSIX-only; on Windows the paths are created without mode enforcement.

- e201c48: Clear this repo's own `pnpm audit --prod` findings (13 high-severity advisories,
  down to 0). `@agentmonitors/core` now declares `drizzle-orm@^0.45.2` (previously
  `^0.45.1`, below the patched release). `@agentmonitors/cli`'s published bundle now
  embeds a patched `fast-uri` and `hono` (pinned forward via a workspace
  `pnpm-workspace.yaml` override on the `@modelcontextprotocol/sdk` dependency tree,
  since both were bundled at their previously-resolved, vulnerable versions). No
  public API or behavior changes.

  **Caveat:** the `lodash-es` advisory (GHSA-r5fr-rjxr-66jc, via `cel-js` ->
  `chevrotain`) is cleared for this repo's own audit/build, but **not** for an
  external `npm install @agentmonitors/core`: `cel-js` is a real, unbundled
  dependency of `@agentmonitors/core`, and its latest release (`0.8.2`) pins an
  exact `chevrotain@11.0.3`, whose own dependency on `lodash-es` stays below the
  patched `4.17.24` even at chevrotain's latest 11.x patch — only `chevrotain@12`
  (a breaking upstream release that drops `lodash-es` entirely) clears it for real
  consumers. That's outside what a workspace-level `pnpm` override can fix (it only
  affects this monorepo's own install), and is tracked as a known upstream-only
  gap rather than force-fixed here.

- 36a2e48: Fix `agentmonitors verify` spuriously FAILing on the recommended default monitor configuration
  (`file-fingerprint` + `urgency: high`, no `notify:` block) on its very first invocation.

  `resolveSettleMs` (`apps/cli/src/verify-budget.ts`) returned `0` whenever a monitor declared no
  `notify` block, but the runtime still applies a default 15s debounce settle to a `high`-urgency
  observation with no explicit `notify` override before it materializes
  (`defaultNotifyConfigForUrgency`, `service.ts`). For the recommended default's 30s
  `file-fingerprint` interval, the auto-derived budget undershot real end-to-end delivery (~60s) by
  exactly that omitted 15s, FAILing at ~53s even though the same monitor passes with a larger
  `--timeout-ms`.

  `resolveSettleMs` now delegates to `defaultNotifyConfigForUrgency` (newly exported from
  `@agentmonitors/core`) instead of reading `monitor.frontmatter.notify` directly, so the budget can
  never drift from the engine's own notify-default resolution. The default settle value is now the
  named constant `schedulingDefaults.highUrgencyDefaultDebounceSettleMs` (15s) rather than a
  hand-mirrored literal. An explicit `notify.settle-for` still overrides the default outright; a
  non-high-urgency monitor with no `notify` still resolves `settleMs` to `0`.

- 9f141bb: `verify --use-workspace-daemon` no longer pollutes the workspace's event stream with a spurious
  event from its own teardown.

  That mode targets the persistent workspace daemon and leaves it running. Previously, verify's cleanup
  deleted its own scratch trigger file (`agentmonitors-verify-<hash>.<ext>`), the live daemon observed
  that deletion as a real change, and a later session's `hook deliver`/`events list` surfaced a spurious
  `File deleted: …/agentmonitors-verify-….md` **first**, ahead of the user's real change — a bad look
  for the "stakeholder-presentable proof" this mode targets (issue #407). The default isolated mode was
  never affected (its throwaway daemon/db are torn down).

  Verify now deletes the scratch file, waits for its own monitor to materialize the resulting deletion
  event, then retracts the exact events its own scratch file produced (the create AND the delete) across
  all sessions. The wait and retraction are scoped to the verified monitor, and the retraction deletes by
  the observed event ids — never a `(monitor, path)` sweep — so a real, pre-existing event at the same
  watched path survives and a second monitor also watching it is unaffected. Real monitored changes, and
  any pre-existing watched file verify merely edits and restores, are never touched.

  This adds a new runtime capability, `AgentMonitorRuntime.retractObjectEvents` (backed by the store),
  which removes a caller-supplied set of a monitor's events by id — plus their per-recipient
  `session_event_state` projections, snapshots, and the affected sessions' seeded cursors; it is exposed
  over the daemon socket as the `events.retractObject` IPC verb.

- Updated dependencies [24e7685]
- Updated dependencies [d519192]
- Updated dependencies [a7b5729]
- Updated dependencies [8638936]
- Updated dependencies [e201c48]
- Updated dependencies [89e705f]
- Updated dependencies [24e7685]
- Updated dependencies [36a2e48]
- Updated dependencies [9f141bb]
- Updated dependencies [720d072]
- Updated dependencies [4e46c41]
  - @agentmonitors/core@0.11.0
  - @agentmonitors/source-file-fingerprint@0.4.0
  - @agentmonitors/source-api-poll@0.4.0
  - @agentmonitors/source-command-poll@0.3.0
  - @agentmonitors/source-incoming-changes@0.3.0
  - @agentmonitors/source-schedule@0.2.0

## 0.8.0

### Minor Changes

- a4c642f: Add `agentmonitors doctor` — a unified, diagnose-only workspace health check. It runs a named sequence of checks (project enabled, monitors directory found, every monitor validates, daemon reachable, lead session present, and per-monitor health) and prints a per-monitor rollup (id, source type, cadence, last-observed, next-due, last-event, and unread/claimed/acknowledged counts for the workspace's lead session — or an explicit never-observed / no-lead-session marker). Each check reports pass/fail/skip with an actionable remediation; doctor exits 0 only when every check passes. Like `monitor explain`, it reads persisted state in-process, so the per-monitor rollup still works (and says so) when the daemon is down. `--format json` emits a stable machine-readable shape documented in the CLI reference. The reusable durable-state diagnosis is exposed on the core runtime as `AgentMonitorRuntime.doctorReport()` (host-agnostic).
- 867f8b7: DX papercut sweep from a blind DX study batch (S1 F3, S2 F4/F5, S5 F3/F4/F5/F7): help-text
  precision, claimed-vs-unread clarity, branding consistency, and symmetric path-argument errors.
  - **`events list` reports each event's delivery state.** `--unread` matches an unacknowledged
    event (002 §7), which includes events already claimed at a delivery lifecycle but not yet
    acknowledged — a surprise for a debugger reading "unread" as "never seen". Each returned event
    now carries a `deliveryState: 'unread' | 'claimed' | 'acknowledged'` field (new optional field on
    `@agentmonitors/core`'s `MonitorEventRecord`, present for the session-scoped `events list`
    query), and the CLI's text output gained a visible `deliveryState` column.
  - **`session open --format id`** prints just the bare session id — no more hand-rolled
    JSON-parsing one-liner needed to pull `.id` out of a verification script.
  - **`monitor test` given a directory now redirects to `agentmonitors validate`**, symmetric with
    `validate`'s existing redirect to `monitor test` for a single-file argument — instead of a raw
    `EISDIR` read error.
  - **`agentmonitors init`'s bootstrap summary** no longer claims unconditionally that "monitoring
    starts automatically when you open a Claude Code session" — that's conditioned on the Claude Code
    plugin being present, with the manual `agentmonitors daemon run` alternative on the next line.
  - **Required CLI options are now marked `(required)`** in their own `--help` output
    (`session open --host-session-id`, `events list`/`ack --session`,
    `hook claim --session`/`--lifecycle`).
  - **The `agentmonitors doctor` banner** now reads `agentmonitors doctor`, matching the real
    invocation (and the same command's own remediation text elsewhere in its output), instead of the
    prose product name "AgentMon".

- 015d2f5: `agentmonitors init` (bare and `--enable-only`) now also ensures `.gitignore` ignores
  `.agentmonitors/` — the project-root runtime directory the daemon creates the moment a session
  opens (per-session `hook-state.json`). Previously only `.claude/*.local.*` was gitignored, so
  following the setup docs exactly left `.agentmonitors/` as an untracked entry in `git status`.
  - Each required `.gitignore` line is checked independently, so a `.gitignore` that already has one
    line but not the other only gets the missing one appended (no duplicates on re-run).
  - `.agentmonitors/` is fully regenerated on every session/tick, so it is always safe to delete.

  The unscoped `agentmonitors` launcher bumps alongside `@agentmonitors/cli` so users installing the
  short name receive the fix.

- 77d9568: Add `hook deliver --debug` for diagnosing silent hook-delivery output (fixes indistinguishable "correctly idle" vs. "misconfigured" states).

  `agentmonitors hook deliver` emits empty stdout + exit 0 both when nothing is pending AND when the stdin payload is misconfigured (unknown session, workspace not enabled, urgency held) — a blind DX study surfaced these as indistinguishable failure modes for the command most often run by an invisible hook system.

  `--debug` writes a step-by-step diagnosis to **stderr only** — stdout stays byte-identical in every mode. It reports which resolution step in the stdin → session → workspace → daemon → session-match chain stopped (or succeeded), pending-event counts by urgency for the resolved session, and a per-band hold reason for anything not yet deliverable: `settle-window` (aging inside the 15s claim-time threshold), `already-claimed` / `coalesced-until-ack` (the same vocabulary `monitor explain`'s reminder-suppression diagnosis uses), or `deferred-by-cap` (deferred by the hook-deliver transport's 4000-char context cap).

  New in `@agentmonitors/core`: a pure, read-only `AgentMonitorRuntime.diagnoseHookDelivery(sessionId, lifecycle)` plus the `HookDeliveryDiagnosis` / `HookDeliveryHold` / `HookDeliveryHoldReason` types and `classifyReminderHold` / `classifySettleWindowHold` classifiers. It never claims or mutates state.

- 96e5b6a: `agentmonitors init` (with no name) is now a one-shot project bootstrap. It enables monitoring
  (`.claude/agentmonitors.local.md` with `enabled: true`), ensures `.gitignore` ignores
  `.claude/*.local.*`, optionally scaffolds a first monitor, validates the result, and prints a
  next-steps summary — collapsing the previously manual onboarding into a single command.
  - Interactive on a TTY; `--yes` accepts defaults non-interactively (and scaffolds a starter
    monitor); `--enable-only` performs the enable + gitignore steps only (for agents/scripts).
  - Idempotent: re-running on an already-set-up project changes nothing and says so.
  - `agentmonitors init <name> --type …` scaffolding is unchanged.

  The unscoped `agentmonitors` launcher bumps alongside `@agentmonitors/cli` so users installing the
  short name receive the new bootstrap.

- a9f7421: `agentmonitors init <name> --type <source>` now accepts three optional seed flags that land
  into the generated `MONITOR.md` frontmatter (value-preserving; quoted as YAML scalars), instead of requiring a hand-edit afterward:
  - `--glob <pattern>` (repeatable) seeds `watch.globs` for `file-fingerprint` or `watch.paths` for
    `incoming-changes`; rejected with a clear error for any other `--type` (those templates have no
    path-pattern list to seed).
  - `--name <name>` seeds the frontmatter `name:` field.
  - `--urgency <low|normal|high>` seeds the frontmatter `urgency:` field.

  Every seeded scaffold still passes `agentmonitors validate`. Omitting all three flags leaves
  `init <name>` byte-for-byte unchanged.

- 0504103: Make a suppressed normal/low-urgency inbox reminder explainable instead of silent. The generic
  `turn-interruptible` (normal) and `turn-idle` (low) reminders coalesce until acknowledgment: once an
  unread event of that band has been claimed but not yet acknowledged, the reminder is intentionally
  suppressed until the claimed events are acknowledged or a fresh unclaimed event arrives — so a
  repeated `hook claim` correctly returns `null`. Previously that `null` was indistinguishable from
  "nothing was ever pending." Now `monitor explain`'s projection-and-delivery stage reports a
  `reminderSuppression` finding per session-and-band naming the reason (`already-claimed` or
  `coalesced-until-ack`) and pointing at the remedy, so "why did nothing surface?" is answerable
  rather than a dead end. The delivery stage stays healthy — a paused reminder is expected behavior,
  not a fault — and no signal is lost (the events remain unread and durable).

### Patch Changes

- 26d9c5c: `agentmonitors doctor` is now cross-referenced from the places users actually hit trouble: both
  `init` closing summaries (bootstrap and `init <name>`) name it as the health-check next step, the
  shared "no daemon running for this workspace" error (`session open/close/list`, `events list/ack`,
  `hook claim`) points at it alongside the `daemon run` fix-it command, and the `SessionStart`
  monitors-found-but-disabled advisory names it too. `doctor`'s own `daemon-reachable` and
  `lead-session` fail lines now note that failing is expected when no agent session is currently
  open, instead of reading as a broken setup.
- fd2aeff: Declare the supported Node runtime and complete npm package metadata on every published package.
  Each package now declares `"engines": { "node": ">=24" }` — a floor at Node 24, the version CI tests — so
  an install on an unsupported Node release gets an actionable npm compatibility warning instead of
  an opaque runtime/native-addon failure. Each package also declares consistent
  `repository`/`bugs`/`homepage` metadata (pointing at its subdirectory of this repo) and ships a
  `README.md`, and the root README states the Node 24 requirement in its install instructions. The
  release-collateral validation run by `pnpm publish:packages:dry-run` (and CI's `publish-dry-run`
  job) now fails loudly if any published package is missing `engines.node`, `repository`, `bugs`,
  `homepage`, `README.md`, or `LICENSE`.
- 697b525: Redeliver hook events omitted by the 4000-char context cap (fixes silent high-urgency signal loss).

  A `turn-interruptible` high-urgency claim used to mark the **full** settled candidate set claimed before the length-bounded hook-deliver transport rendered and truncated it, so events truncated out of the 4000-char `additionalContext` were marked claimed yet never re-delivered at the next context event — durable signal that stayed unread but was never surfaced again.

  The claimed set now equals the rendered set: the transport previews the settled high-urgency delivery without mutating state (`AgentMonitorRuntime.previewSettledHighDelivery`), sizes how many whole event blocks fit under the cap, and claims exactly that many via the new `maxEvents` argument on `AgentMonitorRuntime.claimDelivery`. The deferred remainder stays pending and re-delivers in order at the next context event; every event remains unread until explicitly acknowledged (claiming ≠ acking). Uncapped callers (the channel transport) are unchanged.

- d4299cf: Relicense the published packages under the MIT License. Each package now declares `"license": "MIT"` and ships a `LICENSE` file in its published tarball.
- 2fff581: `session start` no longer quick-exits silently when a project has monitor definitions but is not enabled: it now emits a one-line `additionalContext` advisory through the `SessionStart` hook (monitoring disabled, how many monitors were found, and the exact enable step), while still exiting 0 without opening a session or booting a daemon. A project with no monitor definitions at all still quick-exits fully silently, unchanged.
- de605f3: An explicit `--socket <path>` exceeding the AF_UNIX socket path length limit (100 characters) now prints a warning to stderr naming the requested path, the limit exceeded, and the substituted path before falling back to the hashed `/tmp/agentmonitors-<hash>.sock` socket — the substitution itself is unchanged, but it is no longer silent. `daemon run`, `daemon status`, `daemon stop`, `session open/close/list`, `events list/ack`, `hook claim`, `hook deliver` (only for an explicit `--socket`, not the `.local.md`-derived socket), `channel serve`, `monitor explain`, and `monitor history` all warn on an over-limit explicit `--socket`. Env-var, local-state, and default-derived candidates continue to hash silently, unchanged.
- b7e2711: Fix `agentmonitors doctor` disagreeing with `session list`/`daemon status` about whether a lead session exists, when the daemon was started directly via `agentmonitors daemon run` (the Getting Started guide's own documented usage) rather than lazily booted by a Claude Code hook.

  A directly-invoked `daemon run`/`daemon once` — with no `--socket`/`AGENTMONITORS_DB`/`AGENTMONITORS_SOCKET` overrides — used to bind to the bare global default database and socket, while `doctor` already assumed an enabled workspace gets its own isolated, derived per-workspace database. `session open`, `session list`, and `daemon status` all talked to the live daemon directly and correctly showed an active lead session; `doctor` independently re-derived a different, empty database and reported no lead session at all.

  `daemon run`/`daemon once` now resolve their database and socket the same per-workspace-aware way `doctor` and `session start`'s lazy boot already do, so a directly-started daemon is visible to every other workspace-aware command. `daemon status`/`daemon stop` (previously socket-only) now share the same resolution too, so they keep agreeing after this fix. `session open --workspace` is now resolved to an absolute path (matching `doctor`), and doctor's `lead-session` failure now names the exact workspace path it searched so a future mismatch is self-diagnosing.

- Updated dependencies [a4c642f]
- Updated dependencies [867f8b7]
- Updated dependencies [fd2aeff]
- Updated dependencies [697b525]
- Updated dependencies [77d9568]
- Updated dependencies [d4299cf]
- Updated dependencies [0504103]
- Updated dependencies [b7e2711]
  - @agentmonitors/core@0.10.0
  - @agentmonitors/source-api-poll@0.3.1
  - @agentmonitors/source-command-poll@0.2.5
  - @agentmonitors/source-file-fingerprint@0.3.1
  - @agentmonitors/source-incoming-changes@0.2.6
  - @agentmonitors/source-schedule@0.1.6

## 0.7.0

### Minor Changes

- e4e1c2e: `monitor explain` and `monitor history` now read the persisted SQLite store **in-process** when no daemon is reachable, instead of failing. Previously both were socket-only, so with no daemon running — including right after `daemon once` materialized events — they errored with a raw `connect ENOENT …`, and `monitor explain` reported a false `✗ Scheduling: failure` for a monitor that had actually fired. A read-only diagnosis tool must not require a live daemon.

  On a genuine connection failure the CLI runs the same read-only diagnosis against the local DB and renders the real per-stage report, labeled with a banner ("No daemon running — showing persisted state from the last tick.") in text mode or a `notice` field in `--format json`. When the daemon is down **and** there is genuinely nothing persisted to read, it prints an actionable remediation line (start `agentmonitors daemon run`, or use `monitor test` for a one-shot) rather than a raw `ENOENT`. A daemon-side application error is still surfaced verbatim, never masked as "daemon not running".

- d3e1ba9: feat(cli): add `--format toon|json|text` with agent/human auto-detection to structured-output commands (issue #121, Layer A)

  Adds TOON (Token-Oriented Object Notation, `@toon-format/toon@^2.3.0`) as a `--format` option on the five structured-output commands — `events list`, `scan`, `monitor history`, `monitor explain`, and `source list`.
  - `--format toon`: compact, human-readable encoding designed for LLM context windows; ~40% fewer tokens for typical monitor output shapes; round-trips losslessly to the identical JSON value
  - `--format json` output is **byte-for-byte unchanged** — no regressions for existing JSON consumers
  - `--format text` human-readable columnar output (unchanged)
  - **Default auto-detected per invocation context** via `is-agentic-tui`: agent-driven invocations (Claude Code, Cursor, Gemini CLI, etc.) default to `toon`; interactive human terminals default to `text`; explicit `--format` always overrides
  - TOON is a rendering-only transform at the CLI output edge; durable storage (SQLite, IPC wire) stays JSON
  - Layer B (delivered observation payload) is out of scope — deferred pending a standard-level design decision

### Patch Changes

- 8dbda37: `api-poll` change-detection robustness: non-2xx responses error instead of baselining, and `json-diff` warns on non-JSON bodies (Refs #219, #220)

  **Non-2xx responses are now errored observations, not silent baselines (#220).** Previously
  `api-poll` established its change-detection baseline from **any** HTTP response body, including a
  `401` from a missing/invalid bearer token or a `500` error page — so a misconfigured-auth monitor
  appeared to "work" while silently diffing error pages. For the `text-diff` and `json-diff` strategies,
  a non-2xx status now throws a status-bearing error (`api-poll received HTTP <status> from <url> —
check auth/url; not establishing a baseline on an error response`). The runtime records the tick as
  `errored` (no baseline advance, prior baseline preserved), `daemon once`/`run` report it,
  `monitor history` shows `errored`, and `monitor test` reports `Observation failed: … HTTP <status>`.
  2xx responses baseline/diff exactly as before. **Exception:** the `status-code` strategy still treats
  a non-2xx as a legitimate observed signal (the status is the watched object), so 200 → 5xx detection
  is unchanged.

  **`json-diff` against a non-JSON body now warns (#219).** When `change-detection.strategy: json-diff`
  is configured but the fetched body does not parse as JSON, the source attaches a non-fatal warning to
  the `ObservationResult` (the new optional `ObservationResult.warnings` field) and `agentmonitors
monitor test` prints it, steering the author to `text-diff` for HTML/plain-text pages instead of
  silently degrading to text comparison. The `api-poll` scaffold (`agentmonitors init`) and the
  authoring docs now state strategy-by-content-type inline: `text-diff` for HTML/plain pages, `json-diff`
  for JSON APIs.

- b1bb206: `api-poll` infers the change-detection strategy from the response `Content-Type` (Refs #230)

  `change-detection.strategy` is now **optional**. When it is omitted, `api-poll` infers the strategy
  from the response `Content-Type`: a JSON media type (`application/json` or any structured-syntax
  `+json` suffix, e.g. `application/ld+json`) → `json-diff`; everything else — `text/html`,
  `text/plain`, or a missing/unknown `Content-Type` → `text-diff`. The common "watch a web page" case is
  now zero-config: drop the `change-detection` block entirely and the source picks `text-diff` for an
  HTML page and `json-diff` for a JSON API automatically.

  **An explicit `change-detection.strategy` always wins** — it is used verbatim, with no inference and no
  Content-Type override (user specification is absolute). An explicit `json-diff` against an HTML page
  stays `json-diff` (and still triggers the existing #219 json-diff-on-non-JSON warning); an explicit
  `text-diff` against a JSON body stays `text-diff`. The #219 warning now fires **only** for the explicit
  `json-diff` case — an inferred strategy never warns, because inference picks `json-diff` solely for JSON
  `Content-Type`s and so never mismatches the body.

  The `api-poll` scaffold (`agentmonitors init --type api-poll`) and the authoring docs now show the
  zero-config "watch a page" example and document that `change-detection` is optional and inferred, with
  an explicit override honored. No public-type change.

- 0dd2223: Author-declared baseline strategy: `baseline-strategy: incremental | net` (roadmap G13)

  A monitor may now declare a `baseline-strategy` frontmatter field that controls how the
  per-recipient Diff stage spans a recipient's catch-up span (the observations that accumulated since
  its baseline):
  - `baseline-strategy: incremental` (**default**) — every observation in the span is delivered as its
    own ordered delta (play-by-play). This is the existing, backward-compatible behavior.
  - `baseline-strategy: net` — the span is collapsed per object to a **single** net delta (the last
    observation of each object's run, diffed against the prior snapshot baseline); intermediate churn
    is discarded.

  Omitting the field is equivalent to `incremental`, so existing monitors are unaffected.
  - **core**: new optional schema field (`z.enum(['incremental', 'net']).default('incremental')`),
    surfaced on `MonitorFrontmatter` as `baselineStrategy`; new exported `BaselineStrategy` type; the
    runtime `ingest()` collapses the emitted catch-up span for `net`.
  - **cli**: `agentmonitors validate` accepts `baseline-strategy: incremental | net` and rejects any
    other value.

- a01affb: Use an upstream-safe command-poll scaffold.

  `agentmonitors init --type command-poll` now scaffolds a `git ls-remote origin refs/heads/main`
  `text-diff` monitor instead of a local `git status --porcelain` command, so the generated example
  can watch remote branch tips without relying on stale local refs.

- 33e2f0d: `daemon once` now distinguishes skipped-not-due monitors from no monitors found

  When monitors exist but are skipped because their interval has not elapsed, `daemon once` appends a parenthetical to the summary line: `(N skipped: interval not elapsed — next due in Xs)`, reporting the soonest next-due time across all skipped monitors. Previously, a second `daemon once` run within a monitor's interval printed `Evaluated 0 monitor(s), emitted 0 event(s).` — identical to the "no monitors found" output, making it impossible to distinguish the two cases.

- 1836f04: DX polish (issue #153): validate output consistency, urgency error wording, api-poll feedback
  - **validate**: invalid monitors now display the monitor ID (matching valid-monitor output) instead of the full file path; passing a file path shows a `monitor test` pointer
  - **core**: inverted urgency range error no longer duplicates the field name (`urgency: range "high..normal" is inverted` instead of `urgency: urgency range …`)
  - **api-poll `monitor test`**: HTTP status and response body size are now printed after the baseline so authors can spot bad URLs immediately
  - **api-poll observe**: Node `fetch` errors now propagate the underlying network cause (ECONNREFUSED, ENOTFOUND, timeout) in the message, visible in `monitor explain` output

- c81e868: Teach the inline pipeline idiom for `command-poll` (003 §11.1)

  `command` remains argv-only (spawned with `shell: false` — no injection surface), but the common
  mistake of writing a shell pipeline as a bare string is now self-correcting: `parseScopeConfig`
  rejects a string `command` with a message that names the supported inline form,
  `['sh', '-c', '<pipeline>']`, and the `init --type command-poll` scaffold documents it in a comment.
  No behavior change for existing argv monitors; this only improves the error and the template.

- 19f2d8d: `file-fingerprint` project monitor globs now resolve relative paths from the runtime workspace/config root instead of the daemon process cwd.

  Core now passes `workspacePath` to source observation contexts and records a distinct `no-files-matched` observation outcome when a source can tell that a zero-observation run matched no files. The bundled `file-fingerprint` source uses that context for relative `globs` and relative `cwd`, while preserving absolute `cwd` values and absolute glob patterns. `agentmonitors monitor test` now derives the same config root from the supplied `MONITOR.md` path so dry-runs match daemon ticks.

- 1f27b2e: Surface the file-fingerprint observe interval in source metadata and CLI source listing.

  The file-fingerprint source schema now documents the `watch.interval` knob and its 30s default, and
  `agentmonitors source list` includes per-field descriptions so authors can see that the interval is
  tunable without reading source code.

- 50db864: fix(explain): verdict selects highest-severity stage; materialization is pending during debounce

  `explainVerdict()` previously picked the _first_ stage whose status was not `'ok'`. After
  the `healthy` idle status was introduced in #98, a healthy Observation stage short-circuited
  the scan and masked downstream `failure` or `pending` stages (#149 regression).

  The verdict now selects the _highest-severity_ stage using the ranking
  `failure > pending > healthy > ok`. A healthy or idle observation stage can never mask a
  downstream fault.

  Also fixes the Materialization stage status for the debounce-pending case: when the Notify
  stage is holding a batch (`pending`), the Materialization stage now correctly reports
  `pending`/⏳ rather than `failure`/✗ — the absence of materialized events is expected
  behavior while the debounce settle window has not yet expired.

- b3d5ed3: Add `--format text|json` to `agentmonitors hook deliver` while preserving the default Claude Code
  hook wire output.
- 3743641: Fix: `hook deliver` emits a reminder line for pending `normal`/`low` changes (Refs #198)

  A default file-fingerprint monitor (`urgency: normal`) was silent mid-session. The wired
  `agentmonitors hook deliver` (on `UserPromptSubmit`) emitted **nothing** for a pending
  `normal`-urgency change because `renderHookDelivery` returned `null` whenever the claim carried no
  event bodies (`events: []`), even though the claim had a populated advisory `message`. `hook claim`
  reported the reminder while `hook deliver` — the actually-wired command — did not.

  `renderHookDelivery` now renders the claim's advisory `message` (sanitized and length-capped) into
  `hookSpecificOutput.additionalContext` for a `normal`/`low` reminder claim, producing a visible
  mid-turn reminder line (no per-event body block). The claimed rows are still **not** acknowledged
  (BP2 / SP4), so the event stays unread and re-discoverable via `agentmonitors events list --unread`.

  High-urgency body injection and the `post-compact` (`SessionStart`) recap are byte-unchanged.
  `hook deliver` still prints nothing and exits 0 when there is genuinely nothing pending.

- 9770d85: Use the enabled workspace socket for manual session/events/hook commands and show an actionable no-daemon error.
- Updated dependencies [f6bc858]
- Updated dependencies [5e83550]
- Updated dependencies [8dbda37]
- Updated dependencies [b1bb206]
- Updated dependencies [dcb7ae9]
- Updated dependencies [0dd2223]
- Updated dependencies [33e2f0d]
- Updated dependencies [1836f04]
- Updated dependencies [c81e868]
- Updated dependencies [fe357f3]
- Updated dependencies [19f2d8d]
- Updated dependencies [0b8fece]
- Updated dependencies [3874f52]
- Updated dependencies [ae664c7]
- Updated dependencies [1f27b2e]
- Updated dependencies [5ce5979]
- Updated dependencies [50db864]
- Updated dependencies [745b6fb]
- Updated dependencies [094fc2b]
- Updated dependencies [3ecc9bb]
- Updated dependencies [3e197fc]
- Updated dependencies [8a9388c]
- Updated dependencies [7ab21d3]
- Updated dependencies [e0b52bd]
- Updated dependencies [14c6b94]
  - @agentmonitors/source-api-poll@0.3.0
  - @agentmonitors/core@0.9.0
  - @agentmonitors/source-command-poll@0.2.4
  - @agentmonitors/source-file-fingerprint@0.3.0
  - @agentmonitors/source-incoming-changes@0.2.5
  - @agentmonitors/source-schedule@0.1.5

## 0.6.1

### Patch Changes

- Updated dependencies [dfb124a]
- Updated dependencies [07f8cf7]
  - @agentmonitors/core@0.8.0
  - @agentmonitors/source-api-poll@0.2.3
  - @agentmonitors/source-command-poll@0.2.3
  - @agentmonitors/source-file-fingerprint@0.2.4
  - @agentmonitors/source-incoming-changes@0.2.4
  - @agentmonitors/source-schedule@0.1.4

## 0.6.0

### Minor Changes

- 5c748a4: `daemon once` and the `daemon run` periodic tick log now report monitors whose `observe()` errored on a tick instead of printing a clean `emitted 0 event(s)`. The runtime tick result gains an `erroredObservations: { monitorId, message }[]` field (populated from the same path that records each `errored` row in `observation_history`), and the CLI surfaces a non-zero errored count plus each errored monitor's id and message without a verbose flag. A genuine no-change tick is unchanged, so an author can finally distinguish a broken source from a watched target that simply hasn't changed.

### Patch Changes

- Updated dependencies [5c748a4]
  - @agentmonitors/core@0.7.0
  - @agentmonitors/source-api-poll@0.2.2
  - @agentmonitors/source-command-poll@0.2.2
  - @agentmonitors/source-file-fingerprint@0.2.3
  - @agentmonitors/source-incoming-changes@0.2.3
  - @agentmonitors/source-schedule@0.1.3
