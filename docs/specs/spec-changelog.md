# Spec Changelog

This file records clarifications, contradiction resolutions, and structural changes to the
Agent Monitors spec set in `docs/specs/`.

## Usage

- Add entries when ambiguity is resolved or the intended contract changes.
- Prefer short entries tied to the numbered doc affected.
- If implementation behavior and desired behavior differ, say so explicitly.

## 2026-07-14 — `init` scaffold form: seed flags `--glob`/`--name`/`--urgency` (005 §2) — Refs #330

A blind DX study (5 subjects) found 4 of 5 independently discarded and rewrote the scaffolded
`MONITOR.md` body because `init <name> --type <source>` had no way to seed the fields the user
had already stated — only `--type` was configurable, so every author hand-edited `name:`,
`urgency:`, and the source's path-pattern field by hand (error-prone, per the issue's cited
frontmatter-authoring footguns).

- **005 §2 — new optional flags on the scaffold form (current).** `--glob <pattern>`
  (repeatable), `--name <name>`, `--urgency <low|normal|high>` each replace the corresponding
  template field (value-preserving; `--name`/`--glob` re-emitted as single-quoted YAML scalars) when passed; omitting all three keeps `init <name>` byte-for-byte
  unchanged (unaffected regression coverage: `apps/cli/src/commands/cli.integration.test.ts`
  "AC4 regression"). `--glob` seeds `watch.globs` for `file-fingerprint` and `watch.paths` for
  `incoming-changes` — the two source types whose template has a path-pattern list — and is
  rejected with a clear stderr message (no directory created) for any other `--type`.
- **Bootstrap form unaffected (non-goal).** The bare `init` bootstrap path (§2 "Bootstrap form")
  accepts but does not consume the three seed flags — only the named scaffold form does.
- **Template audit (current, no spec change needed).** The per-source template table (005 §2
  "Templates") was re-verified against this entry's DX-study finding: each of the five
  `--type` templates already produces a source-appropriate `watch:` block with no cross-type
  leftover fields (`apps/cli/src/commands/cli.integration.test.ts` "AC1" parametrized
  regression, one case per source).

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

## 2026-07-14 — Clarify: the normal/low reminder is coalesced-until-ack, and its suppression is explainable (002 §9.2, §9.3, §10.7, §13.3) — Refs #333

A blind DX study subject reported that a durable, unread `urgency: normal` event produced **no**
surfacing at any lifecycle: `hook claim --lifecycle turn-interruptible` returned `null` and
`turn-idle` returned "No pending delivery." Investigation verdict: **not a delivery bug.** §9.2's
guard was working exactly as written — the subject had run an _earlier_ `turn-interruptible` claim
that surfaced the reminder **and** claimed the event; the second identical claim was then correctly
suppressed because the reminder coalesces until acknowledgment. The real defect was that the
suppression presented as bare silence, indistinguishable from "nothing was ever pending."

- **002 §9.2 / §9.3 — clarified (current).** Spell out that delivering the generic reminder _claims_
  the underlying events, so once any unread normal/low event is claimed-but-not-acknowledged the
  guard no longer holds and the reminder is suppressed until acknowledgment or a fresh unclaimed
  event. A repeat claim returning `null` is intended coalescing, not a lost signal (the events stay
  unread and durable). No behavior change — the guard is unchanged; this documents what it already
  does.
- **002 §10.7 — extended (current).** The `monitor explain` projection-and-delivery stage now reports
  a `reminderSuppression` finding per session-and-band naming the reason (`already-claimed` /
  `coalesced-until-ack`) when the coalesced reminder is currently suppressed, so a `null` claim is
  inspectable (the silent-failure-honesty invariant, §1.1.8 / capability C12). The stage stays `ok`
  — a paused reminder is expected behavior, not a fault.
- **002 §13.3 — new example flow (current).** Documents the exact study sequence (first claim
  surfaces + claims; second claim `null`; `monitor explain` names the reason).
- **Core (current).** New pure `diagnoseReminderSuppression` (`libs/core/src/runtime/reminder-diagnosis.ts`),
  wired into the `delivery` stage of `explainMonitor`. No public-type or schema change; the finding
  rides the existing `MonitorExplainStage.details` record. Proven at three layers:
  `reminder-diagnosis.test.ts` (pure), the issue-#333 case in `service.test.ts` (real tick + explain),
  and the issue-#333 case in `cli.integration.test.ts` (real daemon + IPC `hook claim` + `monitor
explain`).

## 2026-07-14 — Cap-bounded hook redelivery: the claimed set must equal the rendered set (006 §5.5) — Refs #299

Spec 006 §5.5 promised that a high-urgency event truncated out of the 4000-char hook
`additionalContext` "re-delivers via the next context event", but the implementation claimed the
**full** settled candidate set before the render truncated it. A truncated-away event therefore had
`first_notified_at` set (claimed) while the pending-turn delivery selects only rows whose
`first_notified_at` is NULL — so it stayed unread yet was **never** re-surfaced automatically. That
is silent P1 signal loss for exactly the sessions with the most pending work, and it contradicted
the section's own guarantee.

- **006 §5.5 — rewritten & retitled (current).** "Unread-recoverability" is now
  "Unread-recoverability & cap-bounded redelivery" and states the contract explicitly: **the claimed
  set MUST equal the rendered set.** A length-bounded transport PREVIEWS the settled high-urgency
  delivery without mutating state (`previewSettledHighDelivery`), sizes how many WHOLE event blocks
  fit under the cap (reserving marker room; never a partial block), then claims exactly that many
  (`claimDelivery`'s `maxEvents`). The deferred remainder stays pending (`first_notified_at` NULL)
  and re-delivers in order at the next context event; every event also remains unread (claiming ≠
  acking, BP2 / SP4) until explicitly acknowledged. The truncation marker is appended whenever any
  pending event is omitted (block did not fit or transport deferred more). Non-high branches
  (reminders, `post-compact` recap) and uncapped callers (the channel transport) are unchanged.
- **No behavior change to acknowledgement, urgency, or projection** — only which events a capped
  `turn-interruptible` claim marks claimed now matches what it renders.

## 2026-07-14 — Plugin manifest must not re-reference the auto-discovered hooks/hooks.json (006 §hooks transport)

Claude Code auto-loads a plugin's conventional `hooks/hooks.json` and **rejects** a manifest
`hooks` entry that resolves to that same file ("Duplicate hooks file detected"), which failed the
plugin's hook load on install. The manifest `hooks` field may only name _additional_ hook files.

- **006 — clarified (current).** The lifecycle hooks remain authored as host-native
  `hooks/hooks.json`, but the doc now states the file is auto-discovered and that a manifest
  reference to it is a load-failing duplicate.
- **Implementation.** Removed `"hooks": "./hooks/hooks.json"` from
  `agent-plugins/agentmonitors/.claude-plugin/plugin.json`. Regression coverage added to the
  plugin config-drift UAT (`apps/cli/src/commands/cli.integration.test.ts`): the suite parses the
  real manifest and fails if any `hooks` reference resolves to the auto-discovered path.

## 2026-07-12 — Add `agentmonitors doctor`: one unified workspace health surface (005 §15, Appendix A) — Refs #267

Answering "is my monitoring working, and if not, where is it broken?" required stitching together
`daemon status`, `monitor explain`, `events list`, and `session list` and knowing non-obvious
distinctions (host vs AgentMon session ids; `monitor explain` verdicts that can disagree with
`events list`). There was no single health surface and no per-monitor last-observed / next-due
rollup — the #1 gap for "easy to see that it's working". `doctor` formalizes the ad-hoc probes the
setup-monitors skill performs into a first-class diagnose-only command.

- **005 §15 — new section (current).** Documents `agentmonitors doctor`: the named check sequence
  (`project-enabled`, `monitors-directory`, `monitors-valid`, `daemon-reachable`, `lead-session`,
  and per-monitor `monitor:<id>`), each with a pass/fail/skip status and an actionable remediation;
  exit 0 iff all checks pass. The per-monitor rollup (id, source type, cadence, last-observed,
  next-due, last-event, and unread/claimed/acknowledged counts for the workspace lead session, or an
  explicit never-observed / no-lead-session marker) and the stable `--format json` shape are
  specified here. `doctor` reads durable state **in-process** (accurate whether or not a daemon is
  running, like `daemon status` and `monitor explain`'s #150 read); the socket is used only for the
  `daemon-reachable` ping.
- **005 §15/§16 — renumber.** The former "Exit codes & diagnostics" section is now §16 (no other doc
  cross-references it).
- **Deliberately narrow (current).** Diagnose-only: no `--fix`, no host-plugin/MCP/channel checks,
  and no change to `monitor explain` (issue #267 non-goals). The `project-enabled` remediation names
  the same enable step as the `SessionStart` monitors-found-but-disabled advisory (006 §5.6) —
  creating `.claude/agentmonitors.local.md` with `enabled: true` — but leads with `agentmonitors init
--enable-only` (005 §2, Refs #268), the one-shot bootstrap command that now does that for you, so
  all three onboarding surfaces agree.
- **Core (current).** The workspace-wide durable-state diagnosis lives in
  `AgentMonitorRuntime.doctorReport()` (host-agnostic, per AP6), reusing the same store reads and
  scheduling logic as `explainMonitor`. The CLI layers the project-enabled and daemon-reachable
  checks (CLI-only concerns) and renders.

## 2026-07-12 — Bare `init` becomes a one-shot project bootstrap (005 §2) — Refs #268

`init <name>` only scaffolded a `MONITOR.md`; onboarding still required hand-creating
`.claude/agentmonitors.local.md` with `enabled: true`, fixing `.gitignore`, and knowing to do both
— steps documented only in the `setup-monitors` skill. Since time-to-first-signal is the product's
core adoption metric, that manual gap is now automated.

- **005 §2 — extended (current).** The section is now "Bootstrap the project, or scaffold a
  monitor". The `<name>` argument is documented as optional: with a name, `init` keeps its exact
  prior scaffold behavior (byte-for-byte); with no name, `init` runs a bootstrap that (1) enables
  the project using the skill's minimal `enabled: true` shape, (2) ensures `.gitignore` ignores
  `.claude/*.local.*`, (3) optionally scaffolds a first monitor (interactive on a TTY, `--yes`
  non-interactively, `--enable-only` to skip), (4) validates the result in-process, and (5) prints
  a next-steps + verify-firing summary. Added the `--enable-only` and `--yes` flags to the flag
  table and an idempotency note (a re-run on an already-set-up project changes nothing).
- **Non-goals (unchanged behavior):** no host-plugin install, no daemon start/persistence (lazy
  boot via `session start` already covers it — §10.4), no MCP, no changes to the monitor schema or
  the `validate` command. `init <name> --type …` output is unchanged.

## 2026-07-12 — 006 §6.1: "Operating without MCP" formalized and proven (006 §6.1, §9) — Refs #270

NP-CH (006 §2) already asserted that channels must be additive, never a dependency, but the hooks-only
mode itself was not named, and the claim that hooks + CLI form a _complete_ substitute for the
`agentmon_ack` MCP tool was undemonstrated. Added §6.1 "Operating without MCP", marked **current**,
stating the guarantee in one paragraph and pointing at the new proof:

- `apps/cli/src/commands/cli.integration.test.ts` — describe block `hooks-only delivery parity
(issue #270)` drives the full lifecycle (daemon boot via `session start`, monitor fire, delivery
  claim via `hook deliver`, acknowledgement via `events ack`, confirmation via `events list`), each
  step fed a real Claude Code hook stdin payload, with zero import/start/reference of the
  channel/MCP code path (`apps/cli/src/commands/channel.ts`).
- `apps/cli/src/commands/channel-hooks-ipc-parity.test.ts` — a separate static check (never imports
  or executes `channel.ts`; reads its source text only) confirming the `agentmon_ack` tool handler
  and the channel's outbound push route through the identical daemon-IPC client functions
  (`acknowledgeEventsClient`, `claimDeliveryClient`) that the hooks-only `events ack`/`hook deliver`
  CLI commands already call — the structural basis for the capability-parity claim.

§9 (Validation Implications) gained a matching bullet for the new proof. No behavior changed; this
is documentation + test coverage of an existing invariant (NP-CH), not a new capability.

## 2026-07-12 — Multi-host agent-facing interaction, ephemeral monitors & observability (new 007; 006 §11; 005 §14) — Refs #259

Formalizes the "Decided shape (2026-06-19)" of Epic #259 into normative spec text. **Spec-only; every
new rule is marked _target_** (nothing here ships yet), grounded on the ratified invariants PP9, PP10,
AP7, NP5 (000-principles, #191). Scope is **local hosts only** — the web-agent defer stands (closed
#126); push-not-poll is unchanged.

### New doc: 007 — Agent-Facing Interaction, Ephemeral Monitors & Observability (target)

Owns the **agent → daemon** direction (the complement of 006's daemon → agent delivery), given its
own numbered doc because request/declaration and delivery are opposite directions with different
contracts:

- **§2–§3 — agent-facing act-on-signal verbs.** Read-only `snapshot` / `diff` (point-to-point) /
  `summary` that read durable state (snapshots, events, cursors) without re-observing and without
  touching delivery state (no claim/ack/cursor move, SP4/BP2). Async-biased; transport (loopback
  HTTP vs the Unix socket) is an implementation detail. An agent acts **in response to a pushed
  signal**, never on a timer of its own (PP9, new non-property NP-AF).
- **§4 — ephemeral monitors.** Agent-declared, session-scoped monitors on the **same daemon and
  pipeline** as persistent `MONITOR.md` monitors (AP7): declared via `watch`, validated by the same
  `validateScope` path, namespaced runtime identity, reaped when the declaring session ends, durable
  across restart while the session lives, all deterministic work daemon-owned (PP9/PP10). Composes
  with dependent chains (#124) and per-binding fan-out (#258) rather than diverging.
- **§5 — observability surface.** `inspect` returns three **distinct** buckets — received / pending /
  **armed-but-not-yet-fired** — where "armed" is derived from the already-durable hold substrate
  (settle/debounce/throttle/rollup windows, `net`/Interpret suppression), a pure read that introduces
  no new watching.

### 006 §11 — Multi-host adapter matrix (target)

Generalizes the single `claudeCodeAdapter` to Claude Code / Codex / Cursor, each CLI + desktop. Fixes
the per-host adapter contract (lifecycle mapping, delivery lifecycle points, session identity,
workspace binding, delivery-surface state, availability/fallback), a **host-generic vs
Claude-specific** classification table of the current 006, the six-surface matrix (Claude current;
Codex/Cursor cells pinned by a per-host probe), the CLI-vs-desktop single-adapter rule, and the
invariant that delivery semantics never change across hosts. A new host is a new adapter, never a
runtime-core change (AP3).

### 005 §14 — Agent-facing verb command sections (target)

Concise target command sections for `snapshot`, `diff`, `summary`, `watch` (declare/list/cancel), and
`inspect`, each referencing 007 for the contract (mirroring how §13 channel references 006 §4). The
prior §14 (Exit codes & diagnostics) is renumbered §15; no external cross-reference targeted the old
§14.

### Supporting updates

- **000 §7** cross-reference index — new 007 row; AP3 added to the 006 row.
- **README** reading-order table + normative range (000–007).
- **glossary** — new terms: agent-facing verb, ephemeral monitor, armed (condition-met-but-not-fired),
  multi-host adapter matrix.
- **roadmap** — gaps G16 (act-on-signal verbs), G17 (ephemeral monitors), G18 (observability),
  G19 (Codex adapter), G20 (Cursor adapter), each with governing property, files, and proof.

Spec-only — no implementation or published-package behavior change, so no changeset. Concrete child
implementation issues are filed from this landed spec per the epic's "spec precedes build" gate.
Refs #259.

## 2026-07-12 — Fix silent opt-in dead-end: `SessionStart` advisory when monitors exist but the project is disabled (006 §5.6, 002 §10.2) — Refs #269

`session start`'s quick-exit for a not-enabled project was **fully silent** in every case,
including when the workspace already has `.claude/monitors/**` definitions and the user simply
never flipped `enabled: true` in `.claude/agentmonitors.local.md`. That combination was the worst
onboarding dead-end: monitors sit unobserved and nothing ever says why, forever.

- **006 §5.6 — extended (current).** Added a "Monitors-found-but-disabled advisory" bullet
  alongside the existing CLI-absent-guard bullet: `session start` now scans `.claude/monitors`
  before quick-exiting on a disabled project. Zero definitions found → unchanged fully-silent
  quick-exit (never nag a user who hasn't opted in at all). One or more found → a single
  `additionalContext` advisory (monitoring disabled, N monitors found, the exact enable step),
  still exiting 0 without opening a session or booting a daemon.
- **002 §10.2 — clarified (current).** The "Lazy boot" section's quick-exit description now
  cross-references 006 §5.6 for this case rather than leaving the reader to infer "not enabled"
  always means silent.
- This is a deliberately narrow fix: no auto-enabling, no advisory on any hook other than
  `SessionStart`, no change to the enabled-path behavior. See the non-goals in issue #269.

## 2026-07-12 — 005 catch-up: `init --type`, `command-poll` enumeration, full command inventory (005 §1, §2, §3, Appendix A) — Refs #265

005 had drifted behind the shipped CLI: it documented `init --source` (the real flag has been
`--type` since the source/scope → watch migration) and its bundled-source enumerations omitted
`command-poll`. Corrected by re-deriving every section from the built CLI's `--help` output and the
`apps/cli/src/commands/*.ts` sources rather than memory.

- **005 §1 — corrected.** "four bundled source packages" → five, adding
  `@agentmonitors/source-command-poll`. The `--version` note no longer hardcodes a literal (it drove
  stale immediately — the doc said `0.0.0` while the shipped CLI was already on `0.7.0`); it now
  states that `getVersion()` reads `package.json` at runtime.
- **005 §2 — corrected.** `init`'s flag table now documents `--type <type>` (not `--source`) with
  all five choices, matching `apps/cli/src/commands/init.ts`; added the missing `command-poll` row
  to the templates table.
- **005 §3 — corrected.** `validate --format json`'s documented shape was missing the `duplicateIds`
  field that `apps/cli/src/commands/validate.ts` has always emitted (same shape as `scan`'s
  `duplicateIds`).
- **005 Appendix A — corrected.** Added the missing `monitor explain` row (present in body prose,
  absent from the inventory table) and corrected `monitor history`'s transport to note its
  in-process no-daemon fallback, matching the already-documented behavior in §6 and matching the
  wording already used on the `daemon status` row.
- Full inventory pass against `apps/cli/src/index.ts` and every `apps/cli/src/commands/*.ts` file
  confirmed no other command/flag drift; the `source search|install|update|remove` placeholders were
  already correctly marked (§7.2–§7.5 headers and Appendix A `Placeholder / not implemented (NP3)`).

## 2026-06-30 — User-level monitor glob scoping: sigil-based syntax + workspace-agnostic events (001 §6.1, §7.5, §8; 003 §2.2, §3.5) — Refs #194

Formalizes the 2026-06-30 design-session decision on user-level monitor glob scoping for the
`file-fingerprint` source. All new rules are marked **target**; project-level behavior is
unchanged.

### Decision summary (v1 — this issue)

1. **Sigil-based scope, no discriminator field.** Leading `/` ⇒ absolute path; leading `~` ⇒
   home-relative; bare relative ⇒ project-relative. Matches universal Unix intuition and requires
   no new vocabulary.
2. **`~` / `~/…` expand to `os.homedir()`.** `~user` (other users' homes) is **not** supported
   and is rejected at validate time.
3. **No mixing of scope classes within one monitor.** Absolute + project-relative and
   home-relative + project-relative mixes are rejected by `agentmonitors validate`. Mixing
   absolute + home-relative is warned but not rejected.
4. **Ship the project-independent forms** (absolute / home / fixed file) — they emit
   workspace-agnostic (`workspacePath: null`) events that project into all lead sessions, reusing
   the existing `sessionsForWorkspace(null)` path.
5. **Bare-relative globs in a user-level monitor are rejected at `agentmonitors validate`** until
   project-relative fan-out is implemented (issue #258). Project-level monitors keep their
   existing behavior: bare-relative = workspace-relative, unchanged.

### Spec changes

- **001 §6.1 — new (target).** Authoring-level spec for the sigil syntax: leading-character
  scope table, `~` expansion rule, no-mixing rule, and the bare-relative-user-level rejection.
  Concrete `globs` authoring examples for all four cases (home-relative user-level, absolute
  user-level, bare-relative project-level, bare-relative user-level rejected). Cross-reference
  to 003 §3.5.

- **001 §7.5 — new (target).** A `~/notes/**/*.md` user-level monitor example that proves the
  home-relative form is the correct authoring pattern for files in the user's home directory; the
  resulting events are workspace-agnostic and project into all lead sessions.

- **001 §8 — extended.** Additional validate obligations listed for the three new rejection cases
  (bare-relative + user-level, `~user`, mixed scope classes).

- **003 §2.2 — clarified.** `context.workspacePath` note updated: for user-level monitors using
  absolute or home-relative globs, `workspacePath` is `null` and the source MUST NOT use the
  daemon process `cwd` as a fallback. Cross-reference to §3.5 added.

- **003 §3.5 — new (target).** Full source-level spec for sigil-based glob scope resolution:
  - §3.5.1 — scope-class determination table (per-pattern, leading-character sigil)
  - §3.5.2 — `~` expansion rule and `~user` rejection
  - §3.5.3 — no-mixing rule with accepted/rejected combinations and rationale
  - §3.5.4 — user-level monitor bare-relative rejection (validate guard + mechanism)
  - §3.5.5 — workspace-agnostic events (`workspacePath: null`, `sessionsForWorkspace(null)`)
  - §3.5.6 — six concrete `globs` examples (valid and invalid)
  - §3.5.7 — required test/validation matrix (8 scenarios drawn from the decision memo Proof)

### Follow-up

Project-relative fan-out (one user-level definition → N workspace-scoped runtime instances,
each with its own baseline and event stream) is tracked in issue #258, sequenced after #192.
This release ships the cheap, high-value project-independent forms only.

## 2026-06-30 — Event-driven file watching for `file-fingerprint`: `watch()` opt-in, `backend` field, reconcile-on-start, and watch-checkpoint contract (003 §3.1, §3.8–§3.10; 002 §2.4) — Refs #192

Ratifies the 2026-06-30 design-session decision. All new rules are marked **target** (not current);
none of this is implemented yet. The `file-fingerprint` source graduates to the first production
adopter of the `watch()` path.

### 003 §3.1 — `backend` scope field added (target)

The `file-fingerprint` scope schema gains an optional `backend` field
(`auto` | `fs-events` | `watchman` | `inotify` | `kqueue` | `windows`, defaulting to `auto`).
The field controls which `@parcel/watcher` backend is used for the watcher. Its failure-policy
semantics are specified in §3.9.

### 003 §3.8 — `watch()` opt-in and reconcile-on-start (target)

`file-fingerprint` MUST implement `watch()`, making it the default change-detection mechanism for
long-lived monitors. The watcher uses `@parcel/watcher` in auto mode (FSEvents / inotify /
ReadDirectoryChangesW / Watchman transparently, in-process, no mandatory external daemon).
`observe()` is retained — non-negotiably — for `daemon once` and for filesystems that cannot
deliver reliable events.

**Reconcile-on-start**: at watcher boot the source MUST run a one-shot `observe()` diff against
the persisted fingerprint baseline to surface changes that occurred while the daemon was offline.
No downtime loss.

### 003 §3.9 — Backend failure policy (target)

Two distinct policies:

- **`auto` (default)**: watcher-init failure → fall back to polling + **loud warning** on the
  monitor (visible in `agentmonitors monitor explain`). Never silent.
- **Pinned backend** (`fs-events`, `watchman`, etc.): unavailable → **fail the monitor** with a
  clear error. No silent swap to another native backend, no silent poll fallback. The implementation
  MUST check backend availability itself before delegating to `@parcel/watcher`, because the library's
  own behavior is to fall back to its default backend when the pinned one is unavailable.

### 003 §3.10 — Periodic source-state checkpointing during watch (target)

During `watch()`, the source MUST periodically write back its updated `FingerprintState` to the
runtime via a new `context.checkpoint(nextState)` callback. This prevents mid-watch crash from
causing duplicate deliveries on restart. The checkpoint MUST be durable before any subsequent
observation is processed (G14 ordering).

### 002 §2.4 — Watch-mode source-state checkpointing contract (target, new section)

The runtime MUST support a `context.checkpoint?: (nextState: unknown) => Promise<void>` callback
on `ObservationContext`, available only to `watch()` implementations. The runtime MUST:

- Persist the provided `nextState` into the monitor's `monitorState.sourceState` durably before
  processing further observations from the same watcher (G14 ordering invariant).
- Serialize checkpoint writes with `ingest()` calls per-watcher to uphold this ordering.
- NOT deliver or materialize any observation as a side effect of a checkpoint.

A checkpoint failure MUST NOT abort the watcher; the source logs a warning and continues.

The former `### 2.4 Tick result` is renumbered `### 2.5 Tick result`; cross-references in §10.1
and §10.2 updated accordingly.

## 2026-06-29 — `api-poll` follow-ups: warning URL redaction and validation docs (003 §4.2, §4.7; 004 §3.2; 005 §2) — Refs #240

Resolved follow-ups from the `api-poll` change-detection cluster.

- **Warning redaction.** The explicit `json-diff` / non-JSON warning now strips URL username,
  password, query, and fragment before diagnostic text is returned, so embedded credentials or
  request tokens are not echoed in `monitor test` output or logs.

- **Scaffold decision.** `agentmonitors init --type api-poll` intentionally omits
  `change-detection.strategy`; the source infers `json-diff` for JSON `Content-Type`s and `text-diff`
  otherwise. 005 now reflects that current template.

- **Spec drift and validation matrix.** 003 §4.7 now matches §4.8: body-diffing strategies reject
  non-2xx responses instead of baselining them. 004 §3.2 now includes required rows for non-2xx
  errored behavior and explicit `json-diff` / non-JSON warnings.

## 2026-06-29 — `file-fingerprint` `cwd` default documentation corrected (003 §3.1) — Refs #245

Clarified that project-level `file-fingerprint` monitors default `cwd` to the workspace/config root,
not the monitors directory.

- **003 §3.1 — clarified.** When `cwd` is omitted, relative `globs` match project files under the
  workspace/config root (`ObservationContext.workspacePath`, the project directory containing
  `.claude`). Relative `cwd` values resolve against that root; absolute `cwd` values are used as-is.
- **Source schema/docs.** The `cwd` field description now exposes the default through
  `source list`, and the authoring guide no longer says "monitors root."

## 2026-06-29 — Upstream branch watching and delivery verification docs (003 §6.4, §11.8) — Refs #244

Documented the source-agnostic upstream-branch recipe and the end-to-end delivery verification path.

- **003 §11.8 — added.** `command-poll` with
  `git ls-remote origin refs/heads/<branch>` and `text-diff` is the recommended way to watch a
  remote branch tip without fetching or mutating local refs.
- **003 §6.4 — clarified.** `incoming-changes` observes local commit-graph advances after pull,
  merge, fast-forward, or local commit; it is not a remote-ahead detector.
- **Authoring docs/scaffold.** `authoring-monitors` now links `api-poll` and `command-poll` authors
  to the shared `.claude/agentmonitors.local.md` enable + `session start` + `hook deliver`
  verification recipe. The `command-poll` init template now uses the upstream-safe `git ls-remote`
  example instead of a local `git status --porcelain` command.

## 2026-06-29 — `file-fingerprint` bare-string `ignore` shorthand (003 §3.1) — Refs #241

`file-fingerprint` now accepts `ignore` as either a bare string or a string array, matching the
existing `globs` shorthand.

- **003 §3.1 — clarified.** A single exclude glob may be written as `ignore: '**/x.txt'` and is
  normalized to the same internal `string[]` representation as `ignore: ['**/x.txt']`.

- **Parser/schema parity.** Both `parseScopeConfig` and `scopeSchema` accept the string form and
  still reject blank or whitespace-only patterns. `schema-parity.test.ts` pins the accepted
  bare-string case and rejected blank-string case.

## 2026-06-29 — `file-fingerprint` ignore exclude globs (003 §3.1, §3.2) — Refs #232

`file-fingerprint` now accepts an optional `ignore: string[]` exclude-glob array alongside `globs`.

- **003 §3.1 — clarified and extended.** A path that matches `globs` but also matches any `ignore`
  pattern is omitted from both the initial baseline and later change detection. Ignore patterns are
  resolved against the same base as `globs`; there is no gitignore-style negation or separate base.

- **Self-trigger guidance.** The docs now call out the common footgun where a monitor watching a
  broad glob writes its own notification artifact back into that glob, causing a re-fire loop. The
  recommended fixes are to write outside the watched tree or exclude generated outputs with `ignore`.

- **Proof:** `plugins/source-file-fingerprint/src/index.test.ts` ("ignore exclude globs") asserts an
  ignored matching file is absent from baseline and does not emit on change, while a non-ignored
  matching file still emits normally. `apps/cli/src/commands/cli.integration.test.ts` pins
  `source list` exposure of the new field.

## 2026-06-29 — `api-poll` status-page HTML volatility guidance (003 §4.2) — Refs #234

Clarified that rendered HTML pages can be unsuitable `api-poll` inputs even when `text-diff` is
correctly inferred from `Content-Type`.

- **003 §4.2 — status-page caveat.** Many rendered status pages embed volatile per-request content
  such as timestamps, CSRF tokens, nonces, or build metadata. Raw `text-diff` can therefore fire on
  every poll even when service status has not changed.

- **Recommended authoring path.** Prefer machine-readable status endpoints when available, such as a
  Statuspage-style `/api/v2/status.json` URL. If only rendered HTML is available, expect noise and
  consider `notify.strategy: debounce`.

- **Authoring docs.** The `api-poll` section now includes a concrete JSON status endpoint example and
  explains why it is preferable for status-page monitoring.

## 2026-06-28 — `api-poll` infers change-detection strategy from `Content-Type` (003 §4.1, §4.2) — Refs #230

`change-detection.strategy` is now **optional** for `api-poll`. Builds on the #219/#220 robustness work.

- **003 §4.2 — new (Refs #230).** When `change-detection.strategy` is **omitted**, the source infers
  it from the response `Content-Type`: a JSON media type (`application/json` or any structured-syntax
  `+json` suffix, per RFC 6838) → `json-diff`; everything else (`text/html`, `text/plain`, a
  missing/unknown `Content-Type`) → `text-diff`. This makes the common "watch a web page" case
  zero-config. The previous omitted-path behavior was a static `text-diff` default; it is now this
  Content-Type inference.

- **Explicit always wins.** An explicitly configured `strategy` is used **verbatim** — no inference,
  no override (user specification is absolute). Explicit `json-diff` against an HTML page stays
  `json-diff`; explicit `text-diff` against a JSON body stays `text-diff`.

- **#219 warning narrowed.** The json-diff-on-non-JSON warning now fires **only** for the _explicit_
  `json-diff` case. An _inferred_ strategy never warns, because inference picks `json-diff` solely for
  JSON `Content-Type`s and so never mismatches the body.

- **003 §4.1 + scaffold + authoring docs.** The §4.1 example marks `change-detection` optional and
  adds a no-`change-detection` "watch a web page" example; the `api-poll` scaffold
  (`apps/cli/src/commands/init.ts`) and `apps/website/.../authoring-monitors.md` do the same.

- **No public-type change.** Inference is internal to the source; `ObservationResult` is unchanged.

- **Proof:** `plugins/source-api-poll/src/index.test.ts` (omitted + `application/json` → json-diff;
  omitted + `application/ld+json` → json-diff; omitted + `text/html` → text-diff; omitted + missing
  `Content-Type` → text-diff; inferred json-diff does not warn; explicit `json-diff` + `text/html` →
  json-diff honored AND warns; explicit `text-diff` + JSON body → text-diff honored).

## 2026-06-28 — `api-poll` change-detection robustness: non-2xx errors, json-diff-on-non-JSON warning, content-type strategy steering (003 §4.2, §4.5, §4.8) — Refs #219, #220

Two related corrections to the `api-poll` source contract, plus authoring guidance.

- **003 §4.8 — new (Refs #220).** A non-2xx HTTP response is now an **errored** observation for the
  `text-diff`/`json-diff` strategies (the source throws a status-bearing error
  `api-poll received HTTP <status> from <url> — check auth/url; not establishing a baseline on an error response`),
  so the runtime records `errored`, `daemon once`/`run` report it, `monitor history`
  shows `errored`, and `monitor test` shows `Observation failed: …`. It no longer silently baselines
  on an error body, which previously masked broken auth/URL (a bad token produced `HTTP 401` yet the
  monitor "observed successfully"). 2xx responses baseline/diff exactly as before. **Exception:** the
  `status-code` strategy still treats a non-2xx as a legitimate observed signal (the status is the
  watched object), so it does not throw — preserving 200 → 5xx detection.

- **003 §4.2 — clarified (Refs #219).** The existing silent `json-diff` → text fallback now also
  emits a **non-fatal warning** (`ObservationResult.warnings`) when `strategy: json-diff` is
  configured against a body that does not parse as JSON. `agentmonitors monitor test` prints it so the
  author is steered to `text-diff` for HTML/plain pages instead of getting quietly wrong diffing. The
  observation outcome is unchanged (still the text fallback). The change-detection table and the
  `api-poll` scaffold (`apps/cli/src/commands/init.ts`) now state strategy-by-content-type inline:
  `text-diff` for HTML/plain pages, `json-diff` for JSON APIs.

- **New public type field.** `ObservationResult.warnings?: string[]` — non-fatal source diagnostics,
  surfaced by `monitor test`; does not mark the cycle errored.

- **Proof:** `plugins/source-api-poll/src/index.test.ts` (401/500 → errored, no baseline; 2xx →
  baseline ok; `status-code` non-2xx still observes; json-diff on non-JSON → warning; json-diff on
  JSON → no warning; text-diff non-JSON → no warning); `apps/cli/src/commands/cli.integration.test.ts`
  (`monitor test` surfaces the status-bearing error and the json-diff warning).
- Minor changeset: `@agentmonitors/source-api-poll` behavior change; patch: `@agentmonitors/core`
  (new optional `ObservationResult.warnings`), `@agentmonitors/cli` (`monitor test` warning output).

## 2026-06-28 — `hook deliver` accepts `--format text|json` and documents no-output preconditions (005 §12.2, 006 §5) — Refs #203

`agentmonitors hook deliver` now accepts the same `--format text|json` shape as the sibling
hook-delivery inspection command while preserving the installed hook wire behavior by default.

- **005 §12.2 — clarified.** The command reference now lists `--format <format>`, explains that the
  omitted/default format and `--format json` emit compact Claude Code hook wire JSON, and documents
  `--format text` as an inspection mode that prints only the rendered `additionalContext`.
- **005 §12.2 / CLI help — clarified.** Emission preconditions are explicit: an enabled project, a
  per-workspace socket in `.claude/agentmonitors.local.md` or `--socket`, a reachable daemon, and a
  matching tracked session. Empty output means nothing is pending or the workspace/session is not
  configured.
- **006 §5.1-§5.3 — clarified.** Hook registration continues to use the default/json wire object, all
  no-op paths remain empty stdout + exit 0, and `--format text` is only for manual inspection.

The always-exit-0 hook safety contract is unchanged. Affects published-package behavior
(`@agentmonitors/cli`), so a changeset accompanies this change.

## 2026-06-28 — Manual daemon commands use the enabled workspace socket (005 §1) — Refs #199

`session open`, `session close`, `session list`, `events list`, `events ack`, and `hook claim` now
resolve the enabled workspace's persisted `.claude/agentmonitors.local.md` `socket:` when no explicit
`--socket` and no `AGENTMONITORS_SOCKET` are present. This aligns manual CLI inspection with the
plugin hook path: in an enabled project, manual commands reach the per-workspace daemon that
`session start` booted; outside an enabled project, the global default socket remains unchanged.

When those manual commands cannot reach the resolved daemon, they now print one actionable stderr
line telling the author how to start a daemon and exit non-zero, rather than exposing a raw
`DaemonConnectionError` stack. Daemon-side application errors remain surfaced normally and still honor
JSON error output where applicable.

- **Proof:** `apps/cli/src/commands/cli.integration.test.ts` covers manual commands reaching the
  per-workspace socket after `session start`, explicit `--socket` / `AGENTMONITORS_SOCKET`
  precedence over that local socket, plus daemon-unavailable remediation for `session open`,
  `session close`, `session list`, `events list`, `events ack`, and `hook claim` with no stack trace.
- Patch changeset: `@agentmonitors/cli` user-visible command resolution/error behavior.

## 2026-06-28 — `hook deliver` emits a reminder line for pending `normal`/`low` changes (006 §5.4, 005 §12.2) — Refs #198

Resolves a contradiction between the spec and the implementation. The spec already said a
`turn-interruptible` `normal`-urgency claim returns `events: []` with **"reminder text only"**, but
`renderHookDelivery` short-circuited to `null` whenever `events.length === 0`, so the wired
`agentmonitors hook deliver` (on `UserPromptSubmit`) emitted **nothing** for a pending
`normal`-urgency change. A default file-fingerprint monitor was therefore silent mid-session —
`hook claim` reported the reminder while `hook deliver` did not.

- **006 §5.4 — clarified.** "Reminder text only" is explicitly **not** silence: `hook deliver`
  renders the claim's advisory `message` (sanitized and length-capped) into
  `hookSpecificOutput.additionalContext` for a
  `normal`/`low` claim (`events: []`), producing a visible mid-turn reminder with no per-event body
  block. Body injection stays reserved for high-urgency settled events and the post-compact recap.
  `renderHookDelivery` returns `null` only for a `null` claim or one carrying neither events nor a
  reminder message.
- **005 §12.2 — clarified.** Step 7 and the closing note now state the reminder-line behavior
  precisely, with a reminder-only wire-output example. The claimed rows are **not** acknowledged
  (BP2 / SP4), so the event stays unread and re-discoverable via `events list --unread`.

High-urgency body injection and the post-compact recap are byte-unchanged. Affects published-package
behavior (`@agentmonitors/cli`), so a changeset accompanies this change. Refs #198.

## 2026-06-28 — file-fingerprint observe interval is surfaced in schema, CLI, and docs (003 §3.1; 005 §7, §9) — Refs #204

`file-fingerprint` now documents `watch.interval` in its source schema with the effective `30s`
default. `agentmonitors source list` includes source field descriptions, so the interval knob is
visible alongside `globs` and `cwd`.

Docs now distinguish the per-monitor observe interval from daemon `--poll-ms`: `watch.interval`
controls when a specific monitor is due to re-check files, while `--poll-ms` is only the daemon
loop-wake cadence. No default timing behavior changed.

## 2026-06-28 — file-fingerprint project globs resolve from config root, not daemon cwd (002 §10.7, §15; 003 §3.1, §3.2; 005 §6) — Refs #193

Project-level `file-fingerprint` monitors now resolve relative `globs` and relative `cwd` from the
runtime workspace/config root (`ObservationContext.workspacePath`), not from the daemon process cwd.
Absolute `cwd` values and absolute glob patterns remain unchanged.

When a run matches zero files, `file-fingerprint` sets
`ObservationResult.outcome: "no-files-matched"`. The runtime records that distinct
`observation_history` outcome instead of ordinary `no-change`, so authors can diagnose a broken
glob/cwd separately from a watched file set with no content changes.

- **Core API:** `ObservationContext` gained optional `workspacePath`; `ObservationResult.outcome`
  gained `"no-files-matched"`; `ObservationOutcome` gained `"no-files-matched"`.
- **Runtime/CLI:** `tick()` and `watch()` pass `workspacePath` into source contexts, and
  `monitor test` derives the config root from the supplied `MONITOR.md` path for direct source
  dry-runs. `monitor test` also short-circuits `no-files-matched` results as an authoring
  diagnostic: it exits 1, prints an explicit `watch.globs` / `watch.cwd` message, and does not
  establish a baseline.
- **Tests:** `plugins/source-file-fingerprint/src/index.test.ts` covers relative glob/cwd
  resolution, absolute path preservation, and zero-match outcome. `libs/core/src/runtime/service.test.ts`
  covers runtime context propagation and the distinct history outcome.

## 2026-06-28 — `file-fingerprint` `globs` accepts a string or an array (003 §3)

Ergonomics: the single-file/single-glob case can now be written as `globs: notes.md` instead of
`globs: ['notes.md']`. [003 §3.1](./003-source-plugins.md) updated to state that `globs` accepts a
bare string (a single pattern) or an array of strings (OR-ed), with the string form normalized to a
one-element array. Empty patterns are rejected. Backward compatible. Part of the "simple cases feel
simple" authoring-ergonomics pass.

## 2026-06-28 — `urgency` is now optional, defaulting to `normal` (001 §3, §3.2)

Ergonomics: `urgency` was a required frontmatter field; it is now **optional** and defaults to the
degenerate band `normal..normal` when omitted, so the minimal valid monitor is a `watch:` block plus
a body. [001 §3](./001-monitor-definition.md) (field table + verified note) and §3.2 updated.
Backward compatible — every monitor that declares `urgency` (a level or a `lo..hi` band) is
unchanged. The default is intentionally `normal` (not `high`): the simplest monitor does not
interrupt the current turn; an author opts into mid-session interruption with `urgency: high`
(gradual reveal). Per maintainer decision, 2026-06-28. Part of the "simple cases feel simple"
authoring-ergonomics pass.

## 2026-06-28 — `command-poll` teaches the inline pipeline idiom (003 §11.1)

Ergonomics/discoverability (no contract change): the argv-only rule for `command` is unchanged, but
a bare-string `command` is now rejected with a message that names the supported inline form,
`['sh', '-c', '<pipeline>']`, and the `init --type command-poll` template documents it in a comment.
[003 §11.1](./003-source-plugins.md) clarifies that shell features are opt-in via an explicit
`['sh','-c',…]` argv (the shell is `argv[0]`, author-chosen, not silently interposed). Part of the
"simple cases feel simple" authoring-ergonomics pass.

## 2026-06-19 — Four invariants added to 000: PP9, PP10, AP7, NP5 — Refs #126

Ratified in the 2026-06-19 product call. Four new principles added to
[000 — Principles & Properties](./000-principles.md):

- **PP9 (agents declare and move on):** An agent may declaratively express monitoring intent but
  performs no watching mechanics itself and never polls or blocks waiting for a signal. The daemon
  owns all observation and waiting; signals are pushed to the agent when ready.
- **PP10 (deterministic daemon floor / ships no model):** The daemon performs only deterministic
  work — observe, shape, diff, persist, project, deliver — and ships no model and holds no
  model-provider credentials. Any summarization or interpretation runs via the user's own installed
  AI tool, opt-in and behind an adapter, never in the daemon core.
- **AP7 (one pipeline, two authoring paths):** Ephemeral, agent-declared, session-scoped monitors
  and persistent `MONITOR.md` monitors are the same runtime machinery. Ephemeral monitors are an
  additional authoring and lifecycle path into the one pipeline, not a parallel system.
- **NP5 (local-agent-only delivery, current scope):** Agent Monitors delivers to local agent hosts
  only; cloud-hosted agents are out of scope while the only known integration path is a polling loop
  that contradicts the push model (pairs with NP1). Revisit only if a host exposes a local
  push/hook primitive.

These invariants ground the multi-host, local-agent-facing direction (#126, recast in the
2026-06-19 product call from "defer web/cloud-agent support" to active multi-host local-agent
support) and dependent chains (#124). The §7 cross-reference index is updated: PP9, PP10, and AP7
added to the `002` row; PP9, PP10, AP7, and NP5 added to the `006` row; PP10 added to the `005`
row.

Spec-only — no implementation or published-package behavior change, so no changeset. Refs #126.

## 2026-06-19 — Default `baseline-strategy` changed from `incremental` to `net` (001 §3.7, 002 §1.1.7) — Refs #110

Implements the 2026-06-19 strategy-call decision: the standard delivery contract is now
**one before/after delta per changed object per notification window** (consolidate by object, not by
monitor; zero reasoning in the daemon).

- **001 §3.7 — default changed.** `baseline-strategy` now defaults to `net`. Omitting the field
  yields per-object consolidation (one delta per changed object per window). `incremental` is the
  explicit opt-out — declare it when the full ordered history of changes matters (e.g. comment
  threads where each reply is a discrete step).
- **002 §1.1.7 — contract updated.** The default-is-`net` semantics are now the normative contract.
  The mechanism is unchanged (per-recipient `collapseNetForClaim` at claim time, G10 PR-B): the
  shared `monitor_events` chain still records every observation (the incremental substrate), and the
  `net` collapse groups pending events per `(monitorId, objectKey, workspacePath)`, delivering only
  the newest per object — delta recomputed against the recipient's own cursor → endpoint — with older
  intermediates recorded claimed-but-suppressed.
- **Schema:** `baselineStrategySchema` (`libs/core/src/schema/monitor-schema.ts`)
  `.default('incremental')` → `.default('net')`.
- **Tests:** `libs/core/src/schema/monitor-schema.test.ts` ("defaults to net when omitted"),
  `libs/core/src/runtime/service.test.ts` ("omitting baseline-strategy defaults to net"),
  `libs/core/src/runtime/object-consolidation.test.ts` (new — canonical 15-saves case + two-object
  envelope + incremental opt-out, all end-to-end through the real runtime tick).
- **No runtime logic change** — only the schema default and the surrounding documentation. The
  per-recipient `net` collapse machinery (G10 PR-B, Refs #182) is unchanged.

## 2026-06-16 — `net` collapse + Interpret rewired onto the per-recipient seam; roadmap G10 complete (002 §1.1.2, §1.1.7, §1.1.8) — Refs #182

Implements roadmap **G10 PR-B** (the final G10 PR), moving the right-of-seam stages of
[002 §1.1](./002-runtime-delivery.md) from the shared baseline onto each recipient's own baseline
cursor. With PR-A's substrate, this flips [002 §1.1.7](./002-runtime-delivery.md#117-baseline-strategy-per-recipient-diff-semantics-current)
and [§1.1.8](./002-runtime-delivery.md#118-interpret-a-cheap-agentic-digest-via-the-users-own-ai-tool)
to fully _current_ and **retires roadmap G10**.

- **002 §1.1.7 — `net` collapse is now per-recipient at claim time (Decision Q3).** The shared
  `monitor_events` chain records **every** observation in order regardless of `baseline-strategy`
  (the incremental substrate — precise over cheap), so an away recipient can be served a correct net
  delta against **its own** cursor. `collapseToNetSpan` is removed from the shared `materializeSpan`
  path. At claim, `RuntimeStore.collapseNetForClaim` (driven by `AgentMonitorRuntime.claimDelivery`)
  groups a recipient's unclaimed events per `objectKey`; for a `net` monitor it delivers only the
  **newest** event per object — with its per-recipient `diff_text` recomputed as
  `buildTextDiff(cursor.baselineContent, newestArtifact)` when the group actually collapsed — and
  records the older intermediates **claimed-but-suppressed** on the new
  `session_event_state.net_suppressed_at` column: retained and explainable via `monitor explain`
  (§10.7), excluded from delivery (unread/pending/recap), never a silent drop. `incremental` (default)
  delivers all in order. The per-recipient cursor still advances to the newest claimed artifact
  (`markClaimed`) even when intermediates are suppressed. A within-tick multi-observation burst for one
  object collapses the same way on the per-recipient side (preserving the same-tick semantics the old
  shared `collapseToNetSpan` provided).

- **002 §1.1.8 — Interpret runs once per distinct per-recipient delta (Decision Q4).** `runInterpret`
  groups projected sessions by their distinct `session_event_state.diff_text` and invokes the adapter
  once per distinct delta, recording the verdict on every session in that group. Interpret runs at
  materialize on the per-recipient single-event delta (the common case); a claim-time `net` re-diff
  re-anchors the delivered delta but **does not re-invoke the adapter** unless the collapsed delta
  string differs from what was already interpreted.

- **Persistence.** New `monitor_events.baseline_strategy` (the author-declared strategy persisted on
  each event so the claim-time net decision needs no monitor re-scan) and
  `session_event_state.net_suppressed_at` (the claimed-but-suppressed marker). Both migrate additively
  (`addColumnIfMissing`); legacy rows keep `NULL` (treated as `incremental` / never net-suppressed).
  `monitor_events` ids now use a monotonic ULID factory so `(created_at, id)` ordering reflects
  insertion order within a single tick — the deterministic "newest event per object" tiebreak the net
  collapse and cursor advance both rely on.

- **Backward compatibility.** A `net` monitor with a single (or co-registered) session that never
  misses a window behaves exactly as before — one event per window, `net` ≡ `incremental` in the
  degenerate single-observation span (no diff is rewritten to empty for a baseline event). The
  shared `monitor_events` chain now keeps every intermediate for a `net` monitor (the visible change:
  `listEvents`/`emittedEventIds` report N, not the collapsed 1 — the collapse is per-recipient at
  delivery). The G13 `net` and issue-#180 rollup/`net` runtime tests were updated to assert this
  intentional shared-chain change plus the per-recipient claim-time collapse.

- **Proof.** `libs/core/src/runtime/net-per-recipient.test.ts` (away-across-3 → one net delta + 2
  suppressed/explainable; `incremental` 3-ordered-deltas contrast; missed-nothing degenerate;
  backward-compat degenerate equivalence; co-registered never-miss; shared-chain keeps all N; cursor
  advances past suppressed intermediates; divergent-baseline Interpret → 2 calls, identical → 1
  fanned). Plus the updated `libs/core/src/runtime/service.test.ts` baseline-strategy and rollup tests.
  Files: `libs/core/src/runtime/{service,store,types}.ts`, `libs/core/src/inbox/{schema,db}.ts`.

## 2026-06-16 — Per-recipient baseline seam + per-recipient Diff shipped (roadmap G10 PR-A; 002 §1.1.2, §5.2, §6) — Refs #182

Implements roadmap **G10 PR-A**, moving the per-recipient Diff substrate of
[002 §1.1.2](./002-runtime-delivery.md#112-the-shared--per-recipient-seam) from _target_ to
_current_. PR-B (rewiring the `net` collapse, §1.1.7, and Interpret, §1.1.8, to span per recipient)
remains open under G10.

- **002 §1.1.2 — per-recipient Diff (current substrate).** The runtime materializes **one** shared
  `monitor_events` row carrying the shaped artifact (the shared object-level diff is retained on
  `monitor_events.diff_text` for `events list`/history), then computes a **per-recipient** delta for
  each projected lead session — the artifact diffed against **that session's own baseline cursor** —
  recorded on the new `session_event_state.diff_text`. Two sessions at divergent stored baselines
  each receive the correct span from one shared observation (capability C15). The per-recipient diff
  is computed inside `insertEvent`'s projection loop, so all durable writes complete **before** any
  Interpret await (the `ingest()` ordering invariant is preserved).

- **New durable table `session_object_cursor`.** One row per
  `(session_id, monitor_id, object_key, workspace_path)`, unique on those keys
  (`COALESCE(workspace_path, '')` collapses the global/`NULL` case). `baseline_content` is
  **denormalized** (the full artifact text) so a recipient's baseline is prune-immune. Cursor
  semantics (product decisions): a recipient's **first** projection of an object seeds its cursor to
  the **pre-event** state, so a session that registered late hears only changes **after** it
  registered (not a full-current-state first delta); the cursor **advances at claim** (`markClaimed`
  moves it to the artifact the recipient was just shown) — materialization only **seeds**, never
  advances; cursors **persist across dormancy and restart** (002 §3, BP1).

- **Backward compatibility.** A single lead session (or sessions co-registered at the same point)
  reproduces the pre-G10 shared diff **byte-for-byte** (the degenerate single-baseline case). Old
  DBs migrate additively (`CREATE TABLE IF NOT EXISTS session_object_cursor` + a unique index +
  `addColumnIfMissing(session_event_state, diff_text)`); a legacy `NULL`
  `session_event_state.diff_text` falls back to the shared `monitor_events.diff_text`. G13 (`net`)
  and G14 (Interpret) are **behaviorally unchanged** — they keep operating over the shared baseline
  on top of this substrate (PR-B rewires them per recipient).

- **Proof.** `libs/core/src/runtime/per-recipient-diff.test.ts`: divergent-baseline fan-out (THE
  proof — A spans artifact2→artifact3, B spans artifact1→artifact3 from one shared obs3), cursor
  restart-safety, session isolation, single-session backward-compat + legacy-`NULL` fallback, and
  the late-joiner new-session seed. The full G11–G15 core suite stays green unchanged.

## 2026-06-16 — Conformance fix: rollup not-due window flush now honors `net` + records audit history (002 §1.1.7, §10.7, §4.4) — Refs #180

No contract change — this records that the **implementation** was brought into conformance with the
existing spec, not a clarification of the spec itself.

- **002 §1.1.7 (net baseline strategy) + §4.4 (scheduled-rollup Pace mode).** A `notify.strategy:
rollup` monitor flushes its accumulated batch via two runtime-tick paths: the source-interval-
  elapsed ("due") path through `ingest()`, and the "not-due" path where the delivery `window` opens
  on a tick whose source poll interval has not elapsed. Per §4.4 the not-due path is the _normal_
  operating mode (authors SHOULD relax `watch.interval` to match the window). The not-due path had
  drifted from `ingest()` and skipped the `net` collapse, so a `rollup` + `baseline-strategy: net`
  monitor delivered the full play-by-play (N events) instead of one net delta. Now both paths route
  through one shared span-materialization helper, so §1.1.7's "one net delta for a missed span"
  holds on both.

- **002 §10.7 / §1.1.6 (audit history).** The same not-due flush wrote no `triggered`
  `observation_history` row, so a real windowed delivery was invisible to `monitor explain` /
  `history`. The shared helper now records the `triggered` row on both paths.

## 2026-06-15 — Interpret stage shipped: cheap agentic digest + significance gate via the user's own AI tool (002 §1.1.8; 006 §2.1; roadmap G14) — Refs #178

Implements roadmap **G14**, moving the optional Interpret stage from _target_ to _current_. This
completes the G11–G15 post-processing-pipeline wave.

- **002 §1.1.8 — Interpret (current).** The runtime runs an optional Interpret stage **after** the
  per-recipient Diff/projection, on the per-recipient delta, **only** for `payload.form: prose`
  (built on G15's `PayloadForm`/`payloadSchema`). A non-`prose` monitor never invokes the adapter.
  The stage produces a cheap, natural-language digest sized to the span and may apply an agentic
  significance gate that suppresses a not-substantive delta. It is **best-effort and never on the
  critical path**: an adapter failure (tool missing / errors / times out) falls back to the
  deterministic §1.1.5 `rendered` artifact (the already-projected delivery) and records the failure —
  delivery correctness never depends on a model call succeeding (PP4, AP3).

- **Host-agnostic adapter boundary (002 §11.1, 006 §2.1 — current).** The AI-tool invocation lives
  behind a new `InterpretAdapter` interface in `libs/core/src/adapter/interpret.ts`; the concrete
  `claude -p` (argv-only, never a shell) invocation is `createClaudeInterpretAdapter`. The runtime
  core (`libs/core/src/runtime/`) owns _when_ Interpret runs (after Diff, before Deliver), _whether_
  it runs (the `prose` gate), and the recording of its decision — never the tool's command string. A
  new host wiring a different AI CLI is a new adapter, not a core change.

- **Ships no model, holds no credentials (C45 — current).** Interpret is disabled unless an
  `InterpretAdapter` is explicitly injected into `AgentMonitorRuntime`; the runtime reads no model
  credential. Summarization runs through the user's own installed tool, inheriting their existing
  data-governance and egress posture by construction.

- **Every decision recorded and explainable (C12 — current).** The per-recipient Interpret verdict
  (`deliver` / `suppress` / `failed`) plus its reason/digest is recorded on `session_event_state`
  (right of the seam) and surfaced by the projection-and-delivery stage of `monitor explain` (§10.7),
  so "why nothing fired" is inspectable — an agentic suppression is a deliberate, recorded outcome,
  never a silent drop. A suppressed projection is retained for explainability but excluded from
  delivery (`unreadEventsForSession` / `pendingEventsForSession`).

Verified: `libs/core/src/adapter/interpret.ts` (`InterpretAdapter`, `createClaudeInterpretAdapter`);
`libs/core/src/runtime/service.ts` (`processObservation` post-Diff Interpret + `runInterpret`
best-effort fallback); `libs/core/src/runtime/store.ts` (`recordInterpretDecision`,
`notInterpretSuppressed` delivery exclusion); `libs/core/src/inbox/schema.ts` +
`libs/core/src/inbox/db.ts` (`session_event_state.interpret_*` columns + additive migration);
`libs/core/src/runtime/interpret-stage.test.ts` (proof criteria a–e);
`libs/core/src/adapter/interpret.test.ts` (concrete adapter argv/parse contract).

## 2026-06-15 — Deterministic Shape stage shipped: derived facts + render-then-diff + payload form (001 §5.1–§5.2; 002 §1.1.4–§1.1.6; 003 §2.7; roadmap G15) — Refs #172

Implements roadmap **G15**, moving the deterministic Shape stage from _target_ to _current_.

- **001 §5.1 — Shape declaration (current).** The `shape` frontmatter field is accepted by the
  schema: `shape.derive` is an ordered list of `{ name, when }` derived-fact rules whose `when` is a
  CEL boolean predicate over `(snapshot, now)`; `shape.render: rendered` opts into the diffable
  artifact. A malformed CEL predicate is rejected at validate. Statically rejecting a predicate that
  _references an identifier outside `(snapshot, now)`_ remains **target** (CEL is structurally pure,
  so determinism holds regardless; such a reference evaluates to "fact does not hold").

- **001 §5.2 — Payload form (current).** The `payload` frontmatter field is accepted: `payload.form`
  is `prose | structured | artifact | rendered`, exported as the stable named type `PayloadForm`
  (a contract the follow-on G14 Interpret stage builds on). For `form: structured`, `payload.transform`
  runs a `jq` reshape or a `cel` gate over the canonical JSON snapshot; a transform under any other
  form, a malformed `jq`/`cel` expression, or an unknown form/language/encoding is rejected.

- **002 §1.1.4 — derived facts (current).** Computed as a pure function of `(shaped snapshot, injected
now)` on the shared side of the seam, before Pace and Diff. `now` is the injected tick clock, never
  an ambient `Date.now()`.

- **002 §1.1.5 — render-then-diff (current).** When `shape` is declared, the runtime renders the
  shaped state (snapshot + facts) to a byte-stable, markdown-ish artifact and diffs **that artifact**,
  not the raw source. The same shaped state renders byte-identically (no phantom diff); a newly-held
  fact is exactly one added line.

- **002 §1.1.6 — payload form (current).** `jq` reshapes the delivered payload; a `cel` gate of
  `false` **suppresses delivery entirely** (no event materialized). The optional Interpret stage that
  `prose` invokes remains **target** (§1.1.8, G14).

- **003 §2.7 — sources surface raw facts (current).** A source surfaces raw timestamps/fields; the
  runtime Shape stage derives the relative facts against `now`.

**Transform evaluator (CSP/Workers-safe).** Both `cel-js` (Chevrotain parser/interpreter) and
`jq-in-the-browser` (PEG parser-combinator) evaluate expressions without the `Function` constructor
or `eval` — the same constraint that drove `@cfworker/json-schema` over `ajv`. `jq-in-the-browser`
implements a practical jq subset (explicit object keys, `map(...)` for array collection); the §5.2
example is updated to that syntax.

Implementation + published-package behavior change — `@agentmonitors/core` minor changeset added.
Refs #172.

## 2026-06-15 — Source contract: snapshots-not-diffs (§2.5) made current; composite observation (§2.6) shipped (003 §2.5–§2.6; roadmap G11) — Refs #173

Implements roadmap **G11**. Both rules were **target**; both are now **current** with `verified:`
references. Capability study rows C2/C6/C40/C43,
[§S1, §S4](../product/monitoring-capability-exercises.md).

- **003 §2.5 — snapshots-not-diffs, now current.** The contract that sources return current-state
  snapshots + `nextState` and the runtime is the sole producer of the consumer-baseline diff is now
  documented on the `Observation` / `ObservationResult` types (`libs/core/src/observation/types.ts`,
  doc-comments only — no type-shape change) and proven against a **bundled** source: a
  `file-fingerprint` unit test asserts the observation is the full current file content with no diff
  field, and an end-to-end test drives the source through the real runtime and asserts the runtime —
  not the source — materializes the `diffText`
  (`plugins/source-file-fingerprint/src/index.test.ts`, "snapshots-not-diffs (003 §2.5)" block;
  reinforced by `libs/core/src/runtime/service.test.ts` "computes a diff against the prior snapshot").

- **003 §2.6 — composite observation, shipped.** The bundled `api-poll` source gains a
  `change-detection.composite` mode that assembles **one** observation from **many** sub-resource
  calls under **one** `object-key`. Parts are rendered sorted by `id` so call ordering never churns
  the snapshot (deterministic, per §2.6); a failed underlying call fails the whole observation
  (baseline preserved, 002 §3); composite and keyed-collection (§12) are mutually exclusive. Verified:
  `plugins/source-api-poll/src/composite.ts` + wiring in `plugins/source-api-poll/src/index.ts`;
  `plugins/source-api-poll/src/index.test.ts` (the "composite observation (003 §2.6)" unit block and
  the "composite × runtime integration" block reducing N calls into one event under one `objectKey`
  with the runtime computing the diff).

- **Roadmap G11** retired (both proof criteria met). A changeset bumps
  `@agentmonitors/source-api-poll` (minor — new authoring surface). `@agentmonitors/core` changes are
  doc-comment-only, so no core changeset and no api-report drift (api-report generation is disabled in
  the base config).

## 2026-06-15 — Author-declared baseline strategy shipped: `incremental` vs `net` (001 §3.7, §7.4; 002 §1.1.7; roadmap G13) — Refs #171

Moves roadmap **G13** from _target_ to _current_. The `baseline-strategy` frontmatter field is now
implemented; the spec sections that described it as target are flipped to current with `Verified:`
references.

- **001 §3.7 / §7.4 — now current.** The `baseline-strategy` field is an optional
  `z.enum(['incremental', 'net'])` defaulting to `incremental`; omitting it is backward compatible
  with today's sequential, one-event-per-observation delivery. The frontmatter table row drops its
  _Target_ label. Section anchors changed from `#37-baseline-strategy-target` to
  `#37-baseline-strategy-current` (and the §7.4 example from target to current); all cross-references
  in 001/002 were updated to match.
- **002 §1.1.7 — now current.** The two Diff modes are enforced by the runtime: `incremental`
  materializes each observation in a catch-up span as its own ordered delta; `net` collapses the
  span per `objectKey` to a single net delta (the last observation of each object's run, diffed
  against the prior snapshot baseline). Anchor changed to
  `#117-baseline-strategy-per-recipient-diff-semantics-current`.
- **Scope (implementation vs. desired behavior).** The catch-up span collapsed by `net` is the set
  of observations emitted into a single delivery over the runtime's **shared** snapshot baseline. The
  full **per-recipient-baseline seam** — divergent-baseline recipients each receiving an
  independently-spanned Diff — remains _target_ under roadmap **G10**; `baseline-strategy` is the
  author-declared mode that seam will apply per recipient. §1.1.7 and §5.2 say so explicitly.
- **Tests:** `libs/core/src/schema/monitor-schema.test.ts` (accept/default/reject),
  `libs/core/src/runtime/service.test.ts` ("baseline strategy (G13, 002 §1.1.7)"),
  `apps/cli/src/commands/cli.integration.test.ts` (`validate` accept/reject).

## 2026-06-15 — Scheduled-rollup Pace mode (`notify: rollup`) shipped: target → current (001 §3.6, §7.3; 002 §3, §4.4, §4.5; roadmap G12) — Refs #170

Implements roadmap **G12** (capability C44, §S5.2). The third Pace mode is now **current**, not
target. Behavior change to the published `@agentmonitors/core` package and its public types, so a
changeset accompanies this change.

- **001 §3.6 — `notify: rollup` (now current).** `agentmonitors validate` accepts a `rollup`
  monitor that supplies a required five-field cron `window` (optional IANA `timezone`, default
  `UTC`) and rejects `strategy: rollup` without `window`. Verified against `rollupNotifySchema` in
  `libs/core/src/schema/monitor-schema.ts` (third arm of the `notifySchema` discriminated union).
  The §7.3 daily-digest example and the §3.4 shape list are updated to reference it.

- **002 §4.4 — runtime semantics (now current).** `dispatchRollup()` in
  `libs/core/src/runtime/service.ts` accumulates each observation into a durable
  `notifyState.pendingRollup` batch (no settle-driven `dueAt` reset), evaluates the author's
  `window` cron each tick via `cronMatchesDate` in the configured timezone, and flushes the whole
  batch as a composite delivery — clearing accumulation — only on a non-empty window. An empty
  window produces no delivery (no empty pings). One `monitor_events` row per accumulated
  observation.

- **002 §3 / §4.5 — persisted state + Pace reference (now current).** The accumulation batch is
  the new `PendingRollupState` (`libs/core/src/runtime/types.ts`), persisted in
  `monitor_state.notify_state`. It survives a daemon restart and reuses the §3 `effectiveUrgency`
  hydration backfill (issue #109) so a restart-recovered envelope never materializes an undefined
  urgency. The §4.5 four-mode Pace table is now fully current.

- **Tests** enforce all five G12 proof criteria: schema accept/reject
  (`libs/core/src/schema/monitor-schema.test.ts`), `validate` accept/reject through the real CLI
  (`apps/cli/src/commands/cli.integration.test.ts`), and durable accumulation, window flush+clear,
  empty-window no-delivery, and restart-safety of the batch
  (`libs/core/src/runtime/service.test.ts`, "rollup Pace mode").

## 2026-06-15 — Roadmap gap dedupe: Deterministic Shape gap renumbered G12→G15 (roadmap) — Refs #168

The roadmap contained two `### G12` headings introduced by separate PRs (#144 and #147), making gap
IDs non-unique and non-monotonic (sequence read G10, G11, G12, G12, G13, G14). No behavior change.

- The Deterministic Shape stage gap (originally G12 from #144) is **renumbered to G15** and
  **relocated** to appear after G14 (Interpret stage), making it the last gap in the sequence.
- The Scheduled-rollup Pace gap (#147) **retains G12**; G13 and G14 are unchanged.
- This file's reference to the Shape gap (the `Post-processing pipeline…` entry below) is updated
  from G12 to G15 to match.
- Gap IDs are now unique and monotonic: G10, G11, G12, G13, G14, G15.

Docs-only — no implementation or published-package behavior change, so no changeset.

## 2026-06-15 — Author-declared baseline strategy: `incremental` vs `net` per-recipient Diff (001 §3.7, §7.4; 002 §1.1.7; roadmap G13) — Refs #146

Formalizes a resolved decision from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
§S5.1; ledger rows **C6** and **C7**). Spec-only; all new rules are marked **target**, not current.
Builds on the per-recipient seam already formalized in [002 §1.1.2](./002-runtime-delivery.md).

- **001 §3.7 — `baseline-strategy` authoring field (target).** A new optional frontmatter field
  with two values: `incremental` (default) — each intermediate observation since the recipient's
  baseline delivered in order (play-by-play); `net` — a single net delta of where things stand
  now vs. the recipient's baseline (intermediate churn collapsed). Omitting the field is
  equivalent to `incremental` — backward compatible with today's sequential delivery. The field
  is per-monitor author intent; the runtime enforces it in the per-recipient Diff stage right of
  the seam (§1.1.2). Motivation and cross-references to C6 / C7 / E1 / E2 / §S5.1 included.

- **001 §7.4 — net-delta spec-doc authoring example (target).** Illustrates `baseline-strategy: net` for a shared spec-doc monitor serving a fleet of agents at divergent baselines (the E2
  scenario), paired with `notify: debounce` — the field works alongside any Pace mode.

- **002 §1.1.7 — Diff: catch-up span and baseline-strategy semantics (target).** Defines the
  **catch-up span** (the set of shaped observations between a recipient's last-seen baseline and
  the current delivery point) and specifies how the Diff stage processes it under each strategy.
  `incremental` delivers _N_ deltas in order for a span of _N_ observations; `net` delivers one
  net delta by comparing the baseline snapshot against the endpoint observation's snapshot,
  collapsing all intermediate observations. Backward compatibility named: the current runtime's
  sequential delivery is the degenerate `incremental` case. Interaction with Pace (independent),
  interaction with the seam (per-recipient concern, right of seam), and test implications included.

- **Roadmap G13** — implementation gap for `baseline-strategy`, P2, with four proof criteria:
  validate acceptance, `net` collapse of a multi-observation span, `incremental` delivery of _N_
  deltas, and omit-equals-incremental backward compatibility. Governs
  [001 §3.7], [002 §1.1.7], C6/C7/§S5.1.

Spec-only — no implementation or published-package behavior change, so no changeset. Refs #146.

## 2026-06-15 — Interpret stage: cheap agentic digest + significance gate via the user's own AI tool, formalized as _target_ (002 §1.1.8; 006 §2.1; roadmap G14) — Refs #145

Formalizes the **cheap agentic Interpret tier** from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
§S4, resolved §S5 item 3; ledger rows **C45/C10/C11/C38/C12**, with E5 as the flagship). Spec-only;
**every new rule is marked target**, not current. Builds on the locked pipeline order (002 §1.1.1,
where Interpret is already a named per-recipient stage after Diff, before Deliver), the
author-declared payload form (002 §1.1.6 / 001 §5.2, where `prose` is the form that invokes
Interpret), and the deterministic `structured`-`cel` significance gate (002 §1.1.6). It does **not**
contradict any _current_ rule: today every monitor delivers its textual diff with no agentic reading,
so an absent Interpret stage is the degenerate, default case, and the host-agnostic-core invariant
(002 §11.1, AP3) is reaffirmed, not changed.

- **002 §1.1.8 — Interpret stage (target).** An **optional** stage that runs **after** the
  per-recipient Diff, on the **per-recipient delta** (right of the seam, §1.1.2), invoked **only** when
  the author declares `payload.form: prose`. It produces a **cheap natural-language digest** sized to
  the span (C10) and **may** apply an **agentic significance gate** that suppresses
  not-substantive changes (C11/C38). Key rules: (a) it runs via the **user's own installed AI tool**
  (e.g. `claude -p …`) — **Agent Monitors ships no model and holds no credentials**, inheriting the
  user's data-governance/egress posture by construction (C45, a first-class trust principle); (b) the
  tool invocation is **host-agnostic, behind an adapter interface, never in the runtime core** (like
  the Claude hook adapter, §11.1, AP3); (c) it is **never on the critical path** — an Interpret
  failure falls back to the deterministic `rendered` artifact (§1.1.5) and is recorded as explainable,
  so delivery correctness never depends on a model call; (d) it **judges the change against author
  criteria, never the recipient's private state** (the stable E2/E5 boundary); (e) the **agentic**
  significance gate is **distinct from** the deterministic shared `cel` gate (§1.1.6) — a comparison
  table fixes the difference and the "deterministic-first, agentic-second" composition; (f) **every
  suppress/deliver decision is recorded and explainable** so "why nothing fired" is inspectable (C12,
  the silent-failure-honesty invariant) — recorded on the **per-recipient** projection surface
  (`session_event_state`, surfaced by `monitor explain` §10.7), **not** the shared tick-level
  `observation_history` where the deterministic `cel`-gate suppression lands.

- **006 §2.1 — the Interpret adapter is upstream of transports, not a transport (target).** Pins the
  boundary: the AI-tool invocation lives behind an adapter (like `claudeCodeAdapter`) and is **not** a
  delivery transport — it helps **produce** the `prose` packet (and may suppress it) **before** any
  transport surfaces it, where a transport (§2) only **surfaces** an already-produced `DeliveryClaim`.

- **roadmap G14** — implementation gap for the Interpret stage, P2, with five proof criteria
  (prose-only invocation, fake-adapter digest, agentic suppression recorded + explainable via
  `monitor explain`, best-effort fallback on tool failure, no-model/no-credentials boundary). Governs
  [002 §1.1.8], [006 §2.1], C45/C10/C11/C38/C12 / §S5 item 3.

Spec-only — no implementation or published-package behavior change, so no changeset.

## 2026-06-15 — Scheduled-rollup Pace mode formalized as _target_ (001 §3.6, §7.3; 002 §4.4–§4.5; roadmap G12) — Refs #147

Formalizes a resolved decision from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
capability C44; resolved §S5.2). Spec-only; all new rules are marked **target**, not current.

- **001 §3.6 — `notify: rollup` authoring surface (target).** The third `notify` strategy,
  `rollup`, is specified: `strategy: rollup` plus a five-field `window` cron expression and an
  optional `timezone` (defaulting to UTC). A `rollup` monitor accumulates observations between
  window openings and delivers them as a single composite batch when the window fires. Authors
  **SHOULD** relax `watch.interval` to match the delivery frequency — polling every 30 s is wasteful
  when delivery is a daily digest. The current schema rejects `strategy: rollup`; this section
  documents the intended authoring surface for the implementation ticket.

- **001 §7.3 — daily digest rollup authoring example (target).** Illustrates `strategy: rollup`
  with a 9am weekday `window` paired with `interval: 1h`, demonstrating the cadence-relaxation
  principle.

- **002 §4.4 — scheduled-rollup Pace mode semantics (target).** Full runtime semantics:
  accumulation in durable `notifyState` across restarts; window evaluation on each tick (five-field
  cron + timezone, same guard as the schedule source); non-empty batch → flush and clear; empty
  window → no delivery (no empty pings, C14). Key clarifications: the flushed batch enters the
  normal materialization → projection → delivery pipeline (§5 → §6 → §9); rollup is entirely on
  the shared side of the seam (§1.1.2); the delivery clock (§9) is independent of the window clock
  (§1.1.3). Three-clocks analysis applied: observation cadence **SHOULD** be relaxed independently,
  reducing token and observation cost (C44, §S5.2 primary motivation).

- **002 §4.5 — complete Pace mode reference (target row for rollup; others current).** A
  four-row comparison table: **immediate** (no notify) / **settle/debounce** (`debounce`) /
  **throttle** (`throttle`) / **scheduled rollup** (`rollup` ⚑). This completes the Pace set:
  no further Pace modes are anticipated. The table frames rollup as the lowest-cost delivery mode
  and the natural pairing with relaxed observation cadence.

- **roadmap G12** — implementation gap for `strategy: rollup`, P2, with five proof criteria
  (validate acceptance, accumulation-between-windows, flush-on-window, empty-window-no-delivery,
  restart-safety). Governs [001 §3.6], [002 §4.4–§4.5], C44/§S5.2.

Spec-only — no implementation or published-package behavior change, so no changeset.

## 2026-06-15 — Deterministic Shape stage: derived facts, render-then-diff, author-declared payload form (001 §5.1–§5.2, 002 §1.1.4–§1.1.6, 003 §2.7) (#144)

Formalizes the **deterministic Shape stage** from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
§S1, §S2 areas C/E/G, §S3 Tier 1, §S5 item 5; ledger rows **C41/C42/C43/C46**, with C3/C4/C5/C21 as
the surrounding Shape area and E8 as the flagship cost story). Spec-only; **every new rule is marked
target**, not current. Builds directly on the just-formalized pipeline-shape framing (002 §1.1) and
does **not** contradict any _current_ rule: today's object-level textual diff (002 §5.2) is the
degenerate case where Shape does no compute/render, and the source/runtime split (PP3, AP3, 003 §2.5)
is reaffirmed, not changed.

- **002 §1.1.4 — Shape: deterministic derived facts (target, C41).** The Shape stage MAY compute
  derived/relative facts (timestamp → "past due"/"due soon", all-tasks-blocked → "stalled",
  defer-threshold-crossed → "revealed", priority+proximity → "urgent") as a **pure function of
  `(shaped snapshot, injected now)`** — no model, no ambient clock — on the **shared** side of the
  seam, **before** Pace and Diff (so a fact appearing/changing is itself a diffable delta). Author-
  declared and optional. Kills the E8 "≈100% waste" of an agent re-deriving these every poll.
- **002 §1.1.5 — Shape: render to a stable artifact, then diff the artifact (target, C42/C43).** Shape
  MAY render the shaped state to a stable, token-efficient, markdown-ish (not JSON) artifact, and the
  runtime MUST diff **that rendered artifact**, never the raw source — pinning the order
  `Observe → [Compose] → Shape(compute → render) → Pace → ⟦seam⟧ → Diff(of the artifact) → …`. Render
  is deterministic (byte-stable, or it produces phantom diffs) and shared; the diff **baseline** is
  per-recipient. Deterministic render is a prerequisite for a useful diff — the structural reason
  Shape precedes Diff.
- **002 §1.1.6 — author-declared payload form (target, C46).** The author declares the payload form —
  `prose | structured | artifact | rendered`. `prose` is the only form that invokes the optional
  Interpret stage; the others are deterministic-floor forms (`structured` is the explicit way to avoid
  a lossy digest for a computing recipient, E6). `structured` is produced by a **turnkey declarative
  transform** — **jq** (reshaping) or **CEL** (predicate) — evaluated over the **canonical JSON** form
  of the shaped snapshot (output `encoding` — json/yaml/toon/toml — is a downstream serialization
  concern, not part of predicate semantics); the transform is constrained, **not** arbitrary code, and
  runs once on the shared side of the seam.
- **001 §3 / §5.1 / §5.2 — authoring surface (target).** Adds optional `shape` (derived facts +
  render) and `payload` (form + transform + encoding) frontmatter blocks, with authoring rules,
  examples, and validation obligations. The §3 frontmatter table gains `shape` and `payload` rows
  marked _target_. Omitting both preserves today's textual delivery.
- **003 §2.7 — sources surface raw facts; the runtime computes derived facts (target, C41).** Draws
  the source/runtime line for **facts** (mirroring §2.5 for diffs): a source surfaces the raw
  primitives (a `due` timestamp, child task states) **as observed** and MUST NOT bake in time-relative
  or aggregate derived facts (which depend on runtime-`now` and would churn the diff); the runtime
  Shape stage derives them. This is where the raw facts the §1.1.4 rules consume originate.
- Glossary entries added (derived fact, rendered artifact, payload form). Roadmap gains target gap
  **G15** (deterministic Shape: derived facts + render-then-diff + payload form), with proof criteria;
  it is the per-stage detail under the §1.1 umbrella that G10 names.
- **Acceptance (004 §6):** every rule is normative + marked _target_; each tricky rule carries an
  example (E8 derived facts, E6↔E8 payload poles) and a test implication (fixed-`now` reproducibility,
  byte-stable render, jq-projection output). No contradiction resolved beyond reaffirming the existing
  split, so the resolution is recorded here per 004 §5.
- Spec-only — no implementation or published-package behavior change, so no changeset. Refs #144.

## 2026-06-15 — Post-processing pipeline shape + source/runtime diff split formalized as _target_ (002 §1.1, 003 §2.5–§2.6)

Formalizes resolved decisions from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
§S1, §S4, §S5; ledger rows C40/C6/C43/C15). Spec-only; every new rule is marked **target**, not
current — the current runtime implements a subset under different names and is reaffirmed, not changed.

- **002 §1.1 — locked pipeline stage order (target).** Names the conceptual stages an observation
  flows through and fixes their order:
  `Observe → [Compose] → Shape → Pace → ⟦seam⟧ → Diff → Interpret → Deliver → [React]` (bracketed
  stages optional). Each stage's responsibility and side of the seam is defined. Shape runs before
  Pace and before Diff (settle and diff the shaped/rendered artifact, not the raw source).
- **002 §1.1.2 — shared / per-recipient seam (target).** Everything left of the seam (Observe…Pace)
  is computed **once** and shared across all recipients; everything right (Diff…Deliver) is **per
  recipient**, against that recipient's baseline/cursor. Identical baselines may dedupe. This is the
  structural reason fan-out is cheap (C15). The current object-level diff (§5.2) is named as the
  degenerate **shared-baseline** case of the target per-recipient Diff — a refinement, not a
  contradiction. §5.2 gains a back-reference.
- **003 §2.5 — sources return snapshots, not diffs (target; reaffirms PP3/AP3).** The source contract
  now states explicitly that a source observes **current state** (+ its own `nextState`
  change-detection state) and the **runtime is the sole producer of the delivery diff**, parameterized
  by the consumer's baseline. A source's `nextState` is its internal "did anything change" cursor, not
  any recipient's baseline; a source MUST NOT compute "what is new for recipient X."
- **003 §2.6 — composite observation (target, C40).** One `Observation` MAY be assembled from many
  source queries/calls into a single stable whole-state snapshot under one `objectKey` — the
  `[Compose]` stage, on the shared side of the seam. Modeling, determinism, and partial-failure rules
  specified.
- Glossary entries added (post-processing pipeline, the seam, composite observation). Roadmap gains
  target gaps **G10** (pipeline stages + per-recipient seam) and **G11** (snapshots-not-diffs +
  composite observation), each with proof criteria.
- Spec-only — no implementation or published-package behavior change, so no changeset.

## 2026-06-15 — CLI: `--format toon|json|text` with agent/human auto-detection on structured-output commands (#121)

**005 §1 (output formats), §4 (scan), §7.1 (source list), §11.1 (events list), §6 (monitor history / explain):**

- Added `toon` as a `--format` choice on all five structured-output commands (`events list`, `scan`, `monitor history`, `monitor explain`, `source list`). All three choices — `toon`, `json`, `text` — are now available on every command.
- **Default is auto-detected per invocation context** (via `is-agentic-tui`): agent-driven invocations (e.g. `CLAUDECODE=1`, `CURSOR_AGENT=1`) default to `toon`; interactive human terminals default to `text`. An explicit `--format` flag always overrides detection. Per-command `Default` column in §4, §6, §7.1, §11.1 updated to `auto (see §1)`.
- `--format json` output is **byte-for-byte identical** to the pre-change behaviour — no regressions for JSON consumers.
- TOON is a rendering-only transform at the CLI output edge. Durable storage (SQLite `monitor_events`, snapshots, source state, hook-state files) and the daemon IPC wire stay JSON everywhere.
- Round-trip safety: `decode(encode(value))` equals the original JSON value; asserted by tests for each command.
- Libraries: `@toon-format/toon@^2.3.0` (MIT, no deps) and `is-agentic-tui` (ISC, no deps). Both confirmed free of `new Function`/`Function(` — pass the CSP/Workers constraint.
- Layer B (delivered observation payload) is explicitly out of scope — deferred pending a standard-level design decision in §006 / the Monitor Standard.

## 2026-06-15 — DX polish: validate output, urgency error wording, api-poll feedback (#153)

Several author-facing DX improvements shipped as a cluster:

- **005 §3 (validate output consistency):** `validate` now displays the monitor ID (folder/stem
  name) for both valid and invalid monitors in text output, not the full file path for errors.
  Passing a file path to `validate` shows a `monitor test` pointer in the error. (Previously,
  invalid monitors printed the full absolute path; valid monitors printed the ID — inconsistent.)

- **core (urgency error wording):** The inverted-range error no longer repeats the field name.
  Before: `urgency: urgency range "high..normal" is inverted …`. After: `urgency: range
"high..normal" is inverted …`. (The Zod path prefix already includes `urgency:` as context.)

- **003 §4.6 (api-poll network error propagation):** Node `fetch` wraps real network errors
  (ECONNREFUSED, ENOTFOUND, …) as `err.cause`. The plugin now catches, extracts the cause
  message, and re-throws `"fetch failed: <cause>"` so `monitor explain` shows the real reason.

- **003 §4.7 (api-poll `monitor test` baseline output):** `monitor test` now prints the HTTP
  status code and UTF-8 response body size after the baseline for `api-poll` sources. This makes
  transport-level successes with unexpected responses (e.g. a 404 on a mistyped-but-resolvable URL,
  or an empty 200) immediately visible. Network-level failures (ECONNREFUSED, ENOTFOUND, …) are a
  separate case: they throw before a baseline exists and are surfaced via §4.6 error propagation
  (visible in `monitor explain`), not via the status/size line.

## 2026-06-15 — `monitor explain` / `monitor history` read the persisted DB in-process when no daemon is running (005 §6, 002 §10.7, #150)

`monitor explain` and `monitor history` were socket-only: with no daemon running — including right
after `daemon once` materialized events — both failed, and `monitor explain` reported a false
`✗ Scheduling: failure` for a monitor that had actually fired. On a genuine `DaemonConnectionError`
the CLI now runs the same read-only `explainMonitor` / `listObservationHistory` **in-process**
against the persisted SQLite store (the `daemon once` pattern) and renders the real diagnosis,
prefixed with the banner _"No daemon running — showing persisted state from the last tick."_ (text)
or annotated with a `"notice"` field (JSON). Only when the daemon is down **and** there is genuinely
nothing persisted (no `observation_history` and no `monitor_events` rows) does the CLI print an
actionable remediation line (`agentmonitors daemon run`, or `monitor test` for a one-shot) instead
of a raw `connect ENOENT …`. A daemon-side application error is still surfaced verbatim, never masked
as "daemon not running" (the #94/#98 distinction holds).

- **Proof:** `apps/cli/src/commands/cli.integration.test.ts` — `describe('monitor explain / history
without a live daemon (issue #150)')`: after `daemon once` with no daemon, `monitor explain` shows
  the real diagnosis + banner and **no** false scheduling failure (text and `--format json`);
  `monitor history` returns the persisted rows; daemon-down-with-nothing-persisted yields the
  remediation message, not an `ENOENT`.
- Minor changeset: `@agentmonitors/cli` (CLI behavior change; no core public-surface change).
- Refs: issue #150 (relates to #94, #149).

## 2026-06-15 — file-fingerprint salience policy: `deleted` → `high`, others → default (003 §3.4)

`file-fingerprint` now emits `salience: 'high'` on `deleted` observations (information permanently
lost) and no `salience` on `created`, `modified`, or `descoped` observations (file still exists or
no information lost). This makes RANGE urgency reachable end-to-end with a bundled source: a monitor
authored with `urgency: normal..high` will receive a `high`-urgency delivery on file deletion and a
`normal`-urgency delivery for all other change kinds. Monitors with a bare scalar `urgency` are
unaffected (the degenerate band `x..x` is never escalated — backward compatible per 003 §2.3).

- **Proof:** `plugins/source-file-fingerprint/src/index.test.ts` — unit tests asserting `salience:
'high'` on `deleted` and absent salience on `modified`, `created`, `descoped`; end-to-end
  integration tests proving the runtime materializes `urgency: 'high'` for a deletion on a
  `normal..high` band monitor and `urgency: 'normal'` for a modification on the same monitor.
- Minor changeset: `@agentmonitors/source-file-fingerprint` (new salience behavior).
- Refs: issue #151.

## 2026-06-15 — monitor explain verdict uses severity ranking, not first-non-ok (005 §6.4, regression #149)

`explainVerdict()` previously selected the _first_ stage whose status `!== 'ok'`. After the `healthy`
idle status was introduced in #98, a healthy Observation stage (not `'ok'`) short-circuited the scan
and masked a downstream `failure` or `pending` stage (#149 regression).

**Fix (005 §6.4):** the verdict now selects the _highest-severity_ stage. Severity order:
`failure(3) > pending(2) > healthy(1) > ok(0)`. A `healthy` or `ok` observation stage can never
mask a downstream fault. The `verdict.status` field in JSON output may now be `"healthy"` for a
fully idle monitor (spec corrected from `"ok|pending|failure"` to `"ok|pending|healthy|failure"`).

**Related fix (005 §6.4):** when the Notify stage is `pending` (debounce/throttle holding a batch)
and no event has materialized yet, the Materialization stage now reports `pending`/⏳ instead of
`failure`/✗ — the absence of materialized events is correct behavior when the notify layer is
holding, not a fault.

## 2026-06-15 — `daemon once` distinguishes skipped-not-due monitors from no-monitors-found (002 §2.4, 005 §9.1)

`RuntimeTickResult` gains a `skippedMonitors: { monitorId, nextDueAt }[]` field, populated from the
same scheduling decision that gates evaluation — never recomputed separately. `daemon once` appends a
parenthetical suffix when non-empty: `(N not yet due — next due in Xs)`, reporting
the soonest next-due time. Previously a second `daemon once` run within a monitor's interval printed
`Evaluated 0 monitor(s), emitted 0 event(s).` — identical to the "no monitors found" output, giving
the author a silent dead end (issue #152). The genuine empty/no-monitors path is unchanged.

- **Proof:** `apps/cli/src/commands/cli.integration.test.ts` — `describe('daemon once skipped-not-due
visibility (issue #152)')`: three tests cover (a) skipped suffix on second run, (b) empty-dir
  unchanged, (c) mixed evaluated + skipped counts reported accurately.
- Patch changesets: `@agentmonitors/core` (new `skippedMonitors` field + `SkippedMonitor` type in the
  public surface) and `@agentmonitors/cli` (user-visible tick output suffix).

## 2026-06-14 — Hydration backfill for pre-upgrade debounce batches (002 §3, restart-safety)

`hydrateStoredObservationEnvelope` now backfills a missing `effectiveUrgency` field (present on envelopes serialized before the range-urgency upgrade) by recomputing it from `effectiveObservationUrgency(monitor, observation)`. Without this, the first daemon restart after upgrade would materialize an invalid (undefined) urgency row. Degrades cleanly when the hydrated monitor snapshot itself lacks `urgencyMax`: returns the base urgency via `URGENCY_BY_RANK[NaN] ?? lo`.

## 2026-06-14 — Range urgency band + per-observation salience (001 §3.2, 002 §4.1/§5.1, 003 §2.3)

A monitor's `urgency` frontmatter is now an authored **band** `lo..hi`; a bare level is the degenerate
band `x..x` (unchanged behavior — fully backward compatible). A source observation may carry an
optional `salience`, and the runtime resolves the effective urgency as
`clamp(salience ?? band.lo, band.lo, band.hi)`.

- **Authored band (001 §3.2):** `urgency: normal..high` authorizes escalation within the band; a bare
  scalar can never be escalated. The schema rejects unknown bounds, malformed ranges, and inverted
  ranges (`lo > hi`). Parsed to `frontmatter.urgency` (low bound — the base/default) +
  `frontmatter.urgencyMax` (high bound).
- **Salience is observation, not policy (003 §2.3):** the per-observation field is named `salience`
  (PP3 — domain observation), reserving `urgency` for the monitor-level policy knob (PP5).
- **Effective urgency + debounce (002 §4.1, §5.1):** notify timing and the materialized
  `monitor_events.urgency` both use the clamped effective urgency. An escalated observation (effective
  urgency above the band's low bound) arriving in a held debounce batch flushes the **whole** batch
  early — it is not split (held-first ordering preserved).
- **Supersedes** the earlier "ceiling" design (min(monitor, source)): a source may now escalate within
  an explicitly authored band, not only de-escalate under a fixed ceiling.
- **Proof:** `libs/core/src/schema/monitor-schema.test.ts` (band parse + inverted/invalid rejection);
  `libs/core/src/parser/parse-monitor.test.ts` (YAML round-trip of a range band, inverted rejection);
  `libs/core/src/runtime/service.test.ts` (salience within band escalates; clamp above/below band;
  degenerate band never escalates; escalation flushes the whole held debounce batch without splitting).
- Minor changeset: `@agentmonitors/core` (public `Observation.salience`, `MonitorFrontmatter.urgencyMax`,
  and the banded-urgency / salience runtime semantics).

## 2026-06-13 — Tick reports errored observations instead of a silent `emitted 0` (002 §2.4, §10.1, §10.2)

`RuntimeTickResult` gains an `erroredObservations: { monitorId, message }[]` field, populated from the
same code path that writes each `errored` row to `observation_history` (single source of truth, no
re-scan). `daemon once` and the `daemon run` periodic tick log now surface a non-zero errored count and
each errored monitor's id + message without a verbose flag — e.g.
`Evaluated 3 monitor(s), emitted 0 event(s), 1 errored:` followed by `  <monitorId>: <message>` lines.
Previously the tick printed a clean `emitted 0 event(s)` even when a monitor's `observe()` threw, so an
author could not distinguish a genuine no-change (not a bug) from a broken source. The genuine
no-change case is unchanged (no errored line — the command must not "cry wolf").

- **Proof:** `libs/core/src/runtime/service.test.ts` (errored monitor surfaced on the tick result with
  its message, including the non-Error throw fallback; a no-change tick has empty `erroredObservations`);
  `apps/cli/src/commands/cli.integration.test.ts` (`daemon once error visibility (issue #117)`: error-only,
  genuine no-change, and a mixed errored/emitted/no-change tick all reported truthfully).
- Minor changeset: `@agentmonitors/core` (new `erroredObservations` field + `ErroredObservation` in the
  public surface) and `@agentmonitors/cli` (user-visible tick output).

## 2026-06-13 — `monitor explain` healthy/idle status, workspace scoping, and connection-only fallback (002 §10.7, 005 §6)

Three corrections to the #94 `monitor explain` command (review of PR #98):

- **Healthy/idle is not a failure.** A `no-change` or `rebaselined` observation outcome now maps to a
  new `healthy` stage status (rendered `○`, distinct from `✓` delivered and `✗` failure) with an
  affirmative verdict ("Source ran, observed 0 changes — your watched target genuinely hasn't changed
  (not a bug)."). Previously a perfectly idle monitor rendered as an error (`✗`/`failure`),
  contradicting #94's contract that "your watched thing genuinely didn't change" is not a bug. When
  the latest observation is `healthy`, the downstream materialization and delivery stages report
  `healthy` for the expected absence of events/projections rather than `✗`. `failure` is reserved for
  real faults (errored observe, invalid definition, missing projection, daemon down). The new status
  is carried in `--format json` as `"status": "healthy"`.
- **Workspace scoping (session isolation).** The inbox DB is global, so the same `monitorId` can
  exist in multiple workspaces. `explainMonitor()` now scopes the materialization stage to the
  explained workspace's `monitor_events` (plus workspace-agnostic events) and the delivery stage to
  that workspace's sessions (plus global sessions), so one workspace's report never counts another
  workspace's events or projections.
- **Connection-only fallback.** The daemon-unavailable fallback now fires only for a genuine
  connection failure (socket refused/absent or request timeout, surfaced as a typed
  `DaemonConnectionError`). A daemon-side application error is surfaced verbatim
  (`Explain failed: <message>`, exit 1) instead of being masked as "daemon not running".
- **Proof:** `libs/core/src/runtime/service.test.ts` (no-change + rebaselined → `healthy`/affirmative
  verdict, no downstream `✗`; cross-workspace event/projection isolation);
  `apps/cli/src/daemon-ipc.test.ts` (application error → plain `Error`, connection failure →
  `DaemonConnectionError`); `apps/cli/src/commands/cli.integration.test.ts` (live daemon application
  error surfaced, not masked).
- Minor changeset: `@agentmonitors/core` (new `healthy` value in the public `MonitorExplainStageStatus`
  union and workspace-scoped explain queries).

## 2026-06-12 — `command-poll` top-level json-diff ignore paths (003 §11.3)

Resolved issue #106 in [003 §11](./003-source-plugins.md): plain `command-poll` `json-diff`
monitors may now set top-level `change-detection.ignore-paths` to remove noisy fields before output
comparison, without requiring keyed-collection mode.

- **Behavior:** `change-detection.ignore-paths: [duration]` under `strategy: json-diff` suppresses
  changes that only affect the parsed JSON `duration` field, while changes to non-ignored fields
  still emit the ordinary command-output `modified` observation.
- **Validation:** `command-poll` `change-detection` now has an explicit allow-list. Unknown keys
  such as `bogus-nonsense-key` fail `agentmonitors validate` instead of validating cleanly and
  silently no-oping. Top-level `ignore-paths` is valid only with `strategy: json-diff`.
- **Proof:** `plugins/source-command-poll/src/index.test.ts` covers the plain `json-diff`
  suppression path, and `apps/cli/src/commands/cli.integration.test.ts` covers rejection of unknown
  `change-detection` keys.

## 2026-06-12 — Keyed-collection paths accept bare dotted authoring form (003 §12)

Resolved an authoring compatibility gap in [003 §12](./003-source-plugins.md): keyed-collection
`path` and `ignore-paths` now accept either explicit-root dotted paths (`$.items`, `$.duration`) or
bare root-relative dotted paths (`items`, `duration`). The two forms are equivalent. This preserves
the original minimal dotted grammar (no wildcards, array indices, filters, or recursive descent)
while matching the monitor-author shorthand used in real `command-poll` configurations.

- **Behavior:** `change-detection.collection.path: items` now resolves to the root `items` array and
  emits per-object `modified`/`created`/`descoped` observations the same way `$.items` does.
  `ignore-paths: [duration]` is treated as element-relative `$.duration`.
- **Proof:** `libs/core/src/observation/keyed-collection.test.ts` covers bare `path` and
  `ignore-paths`; `plugins/source-command-poll/src/index.test.ts` covers the issue #105
  modify/create/descope sequence with `path: items`.

## 2026-06-12 — Keyed-collection change detection shipped (003 §12 target→current; G9 retired)

The `change-detection.collection` mode now turns a poll source's parsed JSON output into a
collection of keyed objects, promoting [003 §12](./003-source-plugins.md) from **target** to
**current** with `verified:` references.

- **Shared core helper.** The per-object diff is implemented **once** as `diffKeyedCollection`
  (`libs/core/src/observation/keyed-collection.ts`, exported from `libs/core/src/index.ts` alongside
  `parseKeyedCollectionConfig` and `resolveDottedPath`) and consumed by **both** `api-poll` and
  `command-poll`. The create/modified/descoped semantics are identical across the two sources;
  sharing the helper avoids a divergence risk that per-plugin copies would carry.
- **Semantics (§12 verbatim).** Each array element becomes a tracked object with
  `objectKey = <monitor-objectKey>#<key-value>`; per-object observations use the existing
  `ChangeKind` vocabulary — `created` (key appears), `modified` (present in both, content differs
  after `ignore-paths` removal), `descoped` (key disappears — never `deleted`). The baseline run
  records the keyed snapshot and emits nothing; reordering and whitespace are inherently ignored
  (comparison is per-key, not positional).
- **`path` syntax (resolving §12's open design point).** `path` is a **minimal `$.`-prefixed dotted
  path** (root `$`, then `.field` segments — `$.tasks`, `$.data.items`); no wildcards, indices,
  filters, or recursive descent. It MUST select exactly one array (a non-array/missing resolution is
  an error). `ignore-paths` entries use the same syntax, relative to each element.
- **BP3 rejection.** A `collection` block is only valid under `strategy: json-diff`. Under
  `text-diff`/`exit-code` (or a defaulted strategy) it is rejected by `agentmonitors validate` with
  `change-detection.collection requires strategy: json-diff` — enforced both by each source's
  generated schema (`if/then`) and by the shared `validate` path (for the actionable message).
- **Proof:** `libs/core/src/observation/keyed-collection.test.ts` (re-sorted → zero observations;
  one element changing → one `modified` with the keyed `objectKey`; addition → `created`; removal →
  `descoped`, not `deleted`; `ignore-paths` suppression; path-not-an-array error); per-source
  integration tests in `plugins/source-api-poll/src/index.test.ts` and
  `plugins/source-command-poll/src/index.test.ts`; and the `validate` rejection/acceptance tests in
  `apps/cli/src/commands/cli.integration.test.ts`. Roadmap **G9** retired.
- Minor changesets: `@agentmonitors/core` (new exported helper), `@agentmonitors/source-api-poll`
  and `@agentmonitors/source-command-poll` (new collection mode).

## 2026-06-12 — Clarify source config wording and old-shape validation hints (003 §7.3, 004 §2.1–§2.3/§3.5, 005 §3/§7.1)

Issue #92 resolves the remaining author-facing ambiguity after the `watch: { type, ... }` migration.
`source list` text now says `Config fields` instead of `Scope fields`, JSON output includes
`configFields` while keeping `scopeFields` as a backwards-compatible alias, and `validate` appends a
targeted hint when a monitor still uses the old top-level `source:` + `scope:` shape. The specs now
distinguish the plugin API term `scopeSchema` from the authoring surface: source config is written
flat inside `watch:` alongside `type`.

- CLI behavior/docs/tests; patch changeset for `@agentmonitors/cli`.

---

## 2026-06-12 — `command-poll` source shipped (003 §11 target→current; G8 retired)

The local-process sibling of `api-poll` is now a bundled source, promoting
[003 §11](./003-source-plugins.md) from **target** to **current** with `verified:` references.

- **New package `@agentmonitors/source-command-poll`** implements §11.1–§11.6 verbatim: argv-only
  `command` spawned directly (`execFile`, `shell: false` — never a shell, so metacharacters pass
  through as literal arguments); `cwd`/`env`/`timeout`/`key`/`interval` scope; `text-diff` (default) /
  `json-diff` / `exit-code` strategies; a 1 MiB stdout cap marking `truncated: true` and diffing
  stably on the capped leading slice; SIGTERM→SIGKILL-after-5s timeout handling that leaves no orphan
  process; `stateful` baseline (first successful run records `{ stdout, exitCode }` and emits
  nothing); and transition-edge failure health (`ok ↔ failing` observations only on the edge — a
  nonzero exit **with** output is a result that gets diffed, while spawn failure and timeout are
  failures that keep prior state). `env` values are never written to any payload, snapshot, or state
  row.
- **Registered** via `registerCoreSources` (`apps/cli/src/sources.ts`) and scaffolded by
  `agentmonitors init --type command-poll` (`apps/cli/src/commands/init.ts`).
- **Proof:** `plugins/source-command-poll/src/index.test.ts` covers the §11.7 list (no-shell
  metacharacter pass-through, per-strategy detection, nonzero-exit-is-a-result, spawn/timeout
  transition edges, env-not-persisted, 1 MiB stable truncation, no-orphan-on-timeout);
  `apps/cli/src/commands/cli.integration.test.ts` covers registration, the init template, and
  `validate` accepting/rejecting a `command-poll` monitor. Roadmap **G8** retired.
- Keyed-collection (§12) and the cursor protocol (§13) remain unbuilt targets (roadmap G9).
- Minor changesets: `@agentmonitors/source-command-poll` (new package) and `@agentmonitors/cli` (new
  source registered + init template).

## 2026-06-12 — `command-poll` implementation correction: `snapshot.command` is the argv array (003 §11.4)

Corrected `changedObservation()` in `plugins/source-command-poll/src/index.ts`: `snapshot.command`
was incorrectly set to `scope.objectKey` (the joined-argv string or `key` override) instead of the
argv array (`scope.command`). §11.4 specifies `snapshot: { command, exitCode, stdoutLength,
strategy }` where `command` is the argv array — matching `payload.command`. This was a behavioral
deviation from the spec; the spec wording is unchanged (it was always correct).

Also tightened `isCommandState()` to require `typeof truncated === 'boolean'`, preventing a
malformed `previousState` (e.g. `truncated: "yes"`) from being accepted and re-persisted through
the failure-path state carry-forward.

## 2026-06-12 — Activation skill authors verified-firing monitors from intent (006 §5.6)

Issue #95 upgrades the activation plugin's bundled `setup-monitors` skill from setup/scaffolding
guidance into an intent-to-working-monitor workflow. The skill frontmatter now triggers on plain
language authoring requests ("watch this file", "tell me when...", "notify me when..."), and the
body instructs agents to select the smallest shipped source type, ask only for required config,
write the monitor body as user judgment, run `agentmonitors validate`, and verify that the monitor
fires before calling setup done. The debug playbook now routes "it didn't fire" reports through
`agentmonitors monitor explain` rather than ad hoc guessing.

- Plugin-skill/test/docs only; no published package changeset.

## 2026-06-12 — `monitor explain` diagnosis command and read-only IPC report (002 §10.5–§10.7, 005 §6)

Issue #94 adds an author-facing pipeline diagnosis command:
`agentmonitors monitor explain <monitorId>`. The command returns a staged report for definition,
scheduling, observation, notify state, materialization, and projection/delivery, with text output
using `✓` / `✗` / `⏳` and a JSON report for agents. The daemon exposes a read-only
`monitor.explain` IPC method that composes the report from existing persisted runtime state:
`monitor_state`, `observation_history`, `monitor_events`, `session_event_state`, and
`agent_sessions`. The CLI also has a daemon-unavailable fallback that validates the local
definition, then reports scheduling as failed because the daemon is not running or unreachable.

- Minor changesets for `@agentmonitors/core` (new public explain report/runtime API) and
  `@agentmonitors/cli` (new command and IPC wrapper).

## 2026-06-11 — Steel-thread UAT now drives the plugin's literal `hooks.json` command strings (004 §3.5 config-drift coverage)

Follow-up to the steel-thread entry below (issue #89, review point 2 of #83, deferred at merge). The
existing steel-thread UAT drives `['session','start']` / `['hook','deliver']` as **argv** with
hand-built stdin — it proves the CLI's stdin contract but skips the seam the #83 bug actually lived
in: the mismatch between the plugin's `hooks.json` command **strings** and that contract (the
now-removed vestigial `&& agentmonitors hook deliver` chain was dead precisely because the first
command had already consumed stdin — invisible to an argv-level test).

A new **plugin hooks.json config-drift UAT** (`apps/cli/src/commands/cli.integration.test.ts`) closes
that gap: it parses the real
[`agent-plugins/agentmonitors/hooks/hooks.json`](../../agent-plugins/agentmonitors/hooks/hooks.json)
at test time (no copies) and runs each `SessionStart` / `UserPromptSubmit` / `SessionEnd` command
**verbatim** through `/bin/sh -c`, with an `agentmonitors` PATH shim satisfying the commands' own
`command -v agentmonitors` guard. It asserts the same end-to-end outcomes as the steel thread (daemon
boots + session registers; the dropped monitor's body arrives as `additionalContext`; session
deregisters; no orphan daemons) plus the missing-CLI fallback branch (empty PATH → the printed
fallback JSON parses and carries the `npm i -g @agentmonitors/cli` install hint). The test therefore
fails if a command string drifts incompatibly (a flag re-added, the binary renamed, the chain
broken), if the stdin contract regresses, or if the fallback emits invalid JSON. Recorded as a new
[004 §3.5](./004-validation-testing.md) scenario row.

- Test-and-spec only — no implementation or published-package behavior change, so no changeset.

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

## 2026-06-11 — Follow-up: §10 session-id-equality question marked resolved (006 §10)

Review follow-up to the entry below (the PR merged before the review comment was addressed): the
2.1.160 re-verification already answered the **next** §10 open question — "confirm
`CLAUDE_CODE_SESSION_ID` equals the `hostSessionId` the `SessionStart` hook passes to
`session open`". The env var equals the live session id (verified), and the hook passes the stdin
`session_id`, which is by the hooks contract that same live id — so both transports resolve the same
identifier. The bullet is now marked **Resolved (2.1.160)** with the same observed-not-contracted
caveat. Docs-only; no changeset.

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

## 2026-06-11 — `session start`/`session end` read the host session id from stdin; steel-thread UAT

**Correction (production bug).** `session start` and `session end` previously read the host session
id from `process.env['CLAUDE_CODE_SESSION_ID']` and quick-exited when it was absent. That env var
**does not exist** in a real Claude Code hook invocation (input arrives as JSON on stdin — the same
issue [`hook deliver`](./006-agent-integration.md) was already corrected for). The effect was severe:
in a real session `session start` returned before booting the daemon, so the session never
registered, and the entire activation chain (lazy daemon boot + delivery) silently no-opped in
production. Plan B's tests passed only because they set the env var manually.

Both commands now read the **stdin hook payload** (006 §5.0): `hostSessionId = payload.session_id`
(no env fallback), `workspacePath = payload.cwd ?? CLAUDE_PROJECT_DIR ?? process.cwd()`. The shared
stdin reader (`readHookPayload` + `HookPayload`) is extracted to `apps/cli/src/hook-payload.ts` and
imported by `hook deliver`, `session start`, and `session end`. Documented in
[006 §5.0/§5.6](./006-agent-integration.md) and [005 §10.4/§10.5](./005-cli-reference.md).

- **Single-process `SessionStart` (one stdin stream).** A Claude Code hook invocation provides **one**
  stdin stream, and both `session start` and `hook deliver` consume all of stdin via
  `readHookPayload()`. So a chained `agentmonitors session start && agentmonitors hook deliver`
  (the previous SessionStart hook form) is broken: `session start` consumes the payload and the
  chained `hook deliver` sees EOF, parses `{}`, and silently no-ops — killing the post-compact recap.
  Fixed by folding the recap into `session start`: it reads the payload **once**, registers, then
  claims `post-compact` and prints the rendered `additionalContext` itself. The SessionStart hook
  (`agent-plugins/agentmonitors/hooks/hooks.json`) now runs the single command
  `agentmonitors session start`. Documented in [006 §5.6](./006-agent-integration.md).
- **Steel-thread UAT added** (Plan D Task 4): an end-to-end CLI integration test that drives the
  `UserPromptSubmit` delivery path over **stdin** — a dropped file-fingerprint monitor + a
  watched-file change ends with the agent handed that monitor's own body-instruction as
  `additionalContext` at the turn boundary. A companion test drives the **actual shipped SessionStart
  command form** (one subprocess, one stdin payload) and asserts the post-compact recap is surfaced by
  that single command — the regression guard for the single-stdin-stream bug above. The Plan B
  lifecycle tests were migrated from `CLAUDE_CODE_SESSION_ID` to stdin payloads so they fail against
  the old env-reading code, locking the stdin contract so the env-var regression cannot return.
- **Follow-up — now resolved (see the channel-binding entry above):** the question of whether
  `channel serve` (`apps/cli/src/commands/channel.ts`) shares the same "no session-id env var" trap was
  verified separately and answered **no** — an MCP-server subprocess _does_ receive
  `CLAUDE_CODE_SESSION_ID` (re-confirmed against 2.1.160), so the channel server's
  `process.env['CLAUDE_CODE_SESSION_ID']` resolution is correct and needs no change. The hooks/stdin
  trap does not transfer (hook = short-lived per-event command with the id on stdin; channel = long-lived
  MCP subprocess that inherits the process environment).
- `@agentmonitors/cli` patch changeset included.

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
