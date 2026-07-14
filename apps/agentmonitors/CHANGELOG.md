# agentmonitors

## 0.9.0

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
- b7e2711: Fix `agentmonitors doctor` disagreeing with `session list`/`daemon status` about whether a lead session exists, when the daemon was started directly via `agentmonitors daemon run` (the Getting Started guide's own documented usage) rather than lazily booted by a Claude Code hook.

  A directly-invoked `daemon run`/`daemon once` — with no `--socket`/`AGENTMONITORS_DB`/`AGENTMONITORS_SOCKET` overrides — used to bind to the bare global default database and socket, while `doctor` already assumed an enabled workspace gets its own isolated, derived per-workspace database. `session open`, `session list`, and `daemon status` all talked to the live daemon directly and correctly showed an active lead session; `doctor` independently re-derived a different, empty database and reported no lead session at all.

  `daemon run`/`daemon once` now resolve their database and socket the same per-workspace-aware way `doctor` and `session start`'s lazy boot already do, so a directly-started daemon is visible to every other workspace-aware command. `daemon status`/`daemon stop` (previously socket-only) now share the same resolution too, so they keep agreeing after this fix. `session open --workspace` is now resolved to an absolute path (matching `doctor`), and doctor's `lead-session` failure now names the exact workspace path it searched so a future mismatch is self-diagnosing.

- Updated dependencies [26d9c5c]
- Updated dependencies [a4c642f]
- Updated dependencies [867f8b7]
- Updated dependencies [fd2aeff]
- Updated dependencies [015d2f5]
- Updated dependencies [697b525]
- Updated dependencies [77d9568]
- Updated dependencies [96e5b6a]
- Updated dependencies [a9f7421]
- Updated dependencies [d4299cf]
- Updated dependencies [0504103]
- Updated dependencies [2fff581]
- Updated dependencies [de605f3]
- Updated dependencies [b7e2711]
  - @agentmonitors/cli@0.8.0

## 0.8.0

### Minor Changes

- ff416d9: First published release of the unscoped `agentmonitors` launcher: install the Agent Monitors CLI with `npm i -g agentmonitors`. A thin wrapper that runs `@agentmonitors/cli`.
