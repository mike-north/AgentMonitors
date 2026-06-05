# Design — Drop-in monitors & the local-file-watch steel thread

> **Status:** Design (pre-implementation). Not yet a numbered canonical spec.
> **Date:** 2026-06-04
> **Supersedes/feeds:** will land as edits to [001](../001-monitor-definition.md) (authoring),
> [002](../002-runtime-delivery.md) (runtime/delivery), [005](../005-cli-reference.md) (CLI),
> [006](../006-agent-integration.md) (transports) once implemented, with a
> [spec-changelog](../spec-changelog.md) entry per change.
> **Decided with:** the product owner, via a structured brainstorm (see "Decisions" at the end).

## 1. Vision

In an ideal world you `mkdir .claude/monitors/` (or `.codex/monitors/`), drop in a markdown file
with YAML frontmatter that is a **complete definition of what to monitor**, and from your next
session onward the agent is told — with that file's own instructions — when the thing happens, and
acts. No bespoke wiring per monitor. This mirrors how an agent **skill** is a self-contained
markdown file the host discovers and activates.

This document designs the **first steel thread** that makes this real end-to-end, chosen to be the
thinnest complete slice that proves the shared spine, plus the spine's deliberate path to the harder
threads.

## 2. The spine and the threads

Every drop-in monitor scenario shares one spine:

> **drop a complete `.md` → activate → observe → deliver into a session → agent reacts**

Six candidate scenarios were scoped. They differ along exactly two axes that create all the real
work:

| Axis                 | Cheap end                       | Expensive end                       |
| -------------------- | ------------------------------- | ----------------------------------- |
| **Source modality**  | poll (file, api, schedule, URL) | push (webhook/Hookdeck) · peer-edit |
| **Delivery fan-out** | one session                     | N concurrent sessions               |

Everything else (the authoring shape) is shared. The scenarios, and where they sit:

1. **Local file/test watch** — poll, one session. _(steel thread #1 — this doc)_
2. **Multi-agent spec sync** — peer-edit, **N sessions**. _(thread #2 — same source + fan-out)_
3. **PR / CI / issue watch** — api-poll + auth, one session.
4. **Scheduled / cron** — schedule, one session.
5. **External API/endpoint change** — api-poll, one session.
6. **Webhook ingestion (Hookdeck)** — **push**, one+ sessions. _(maps onto the `watch()` path)_

**Sequencing:** thread #1 (local file watch) proves activation + delivery with zero creds and zero
new sources. Thread #2 (spec-sync) is then _the same `file-fingerprint` source plus multi-session
fan-out_ — the minimal next step up, which is why it is second.

## 3. Authoring layer

### 3.1 On-disk shape — flat file, promote to folder

A monitor is, by default, a **flat file**: `.claude/monitors/<name>.md` (ID = filename). When it
needs companion assets (fixtures, a script, sub-prompts), it is **promoted to a folder**:
`.claude/monitors/<name>/MONITOR.md` (ID = dir name). Both forms scan; the flat form is the literal
"just drop a markdown file."

- _Net-new:_ the scanner is `**/MONITOR.md`-only today
  (`libs/core/src/parser/scan-monitors.ts`); it must also match flat `.claude/monitors/*.md`, with
  ID derivation per form.

### 3.2 The public contract (frontmatter)

Frontmatter is a **public API**: once files exist on disk, renames are breaking changes. The v1
contract is deliberately lean:

| Field     | Required?    | Notes                                                                                                                                                                           |
| --------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`  | **required** | kebab-case source name                                                                                                                                                          |
| `scope`   | **required** | source-specific map                                                                                                                                                             |
| `urgency` | **required** | `low \| normal \| high`. Also drives **default delivery timing** (high→interrupt, low→idle), so no separate timing field is added (it would create two knobs for one decision). |
| `name`    | optional     | display name; **defaults to file/dir name**                                                                                                                                     |
| `notify`  | optional     | debounce/throttle coalescing (unchanged)                                                                                                                                        |
| `tags`    | optional     | free-form categorization                                                                                                                                                        |

**Removed:** `event-kind`. It was _required_, behaviorally inert (stored + filterable, but no code
branches on `mutation`/`notification`/`alert`), and its enum mixed axes; categorization is covered by
`tags`, change-nature by the shipped `changeKind` (`created/modified/deleted/descoped`), and
importance by `urgency`. Removing it is a **breaking change** — acceptable pre-1.0 (a minor) — and
touches the frontmatter schema, the `event_kind` DB column + filter, and the exported
`EventKind`/`eventKindValues`.

**Body = instructions.** The markdown body is the handling prompt surfaced to the agent on delivery.
The file is "complete" because the body says what to do.

**Tiered, per-thread.** Optional delivery/handling fields are introduced _with the thread that proves
one is needed_, named at implementation — not speculatively. The first such field will likely be a
**fan-out/targeting** field for thread #2 (spec-sync), which `urgency` does not cover.

Smallest valid monitor:

```yaml
---
source: file-fingerprint
scope: { globs: ['src/**/*.ts'] }
urgency: normal
---
Files under src/ changed. Review the diff; flag anything risky before I continue.
```

### 3.3 Two file roles (do not conflate)

|                 | `.claude/monitors/*.md`                              | `.claude/agentmonitors.local.md`                                     |
| --------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| **Role**        | monitor **definitions** (what to observe)            | plugin **state/config** (local coordination)                         |
| **Git**         | **committed** (shared; spec-sync needs them in-repo) | **gitignored** (`.local.md`, per-user)                               |
| **Holds**       | `source`/`scope`/`urgency` + body                    | `enabled` toggle, the project daemon's socket/db path, reaping prefs |
| **Cardinality** | many                                                 | one                                                                  |

The `.local.md` follows the standard Claude-Code plugin-settings idiom (frontmatter config read by
hooks with a quick-exit pattern). It is how the hooks **find the daemon**.

## 4. Activation layer

The "drop a file → it's live" magic lives entirely here. Distribution and the daemon lifecycle.

### 4.1 Distribution — a colocated `aipm` marketplace plugin

Activation ships as **one Claude-Code/Codex/… plugin in a colocated marketplace** in the
AgentMonitors repo, using the `@ai-plugin-marketplace` toolkit (`aipm`). This replaces any
"`init` writes `settings.json`" approach: the plugin _is_ the distribution, and it is cross-host —
directly satisfying the `.claude/` **or** `.codex/` ambition.

Setup (via the `marketplace-authoring` skill):

- `aipm.repo.ts` → `pluginsRoot: 'agent-plugins'`, `distDir: 'agent-plugins/dist'` (our `plugins/`
  is taken by the `source-*` packages).
- `aipm.workspace.ts` → marketplace metadata (opts into generated registries).
- `aipm scaffold agentmonitors` → `agent-plugins/agentmonitors/` with `aipm.config.ts`
  (`targets: [claude, codex, cursor, gemini, kiro, vercel]` — single plugin, so all hosts are
  eligible).
- Author the plugin: `hooks/claude.yaml` (boot/deliver/reap), `.mcp.json` (the channel server), a
  setup `skills/…/SKILL.md`.
- `aipm build` + `aipm validate`; commit sources **and** generated registries; exclude the
  marketplace paths from Prettier; wire `aipm validate` into CI.

Install: `/plugin marketplace add mike-north/AgentMonitors` (Claude), `codex plugin marketplace add …`
(Codex), or `npx plugins add …` (cross-tool).

### 4.2 The lazy project daemon

- **SessionStart hook** → reads `.claude/agentmonitors.local.md` (quick-exit if `enabled: false` or
  absent); **lazy-boots** the project daemon if its socket isn't answering (detached spawn so the
  daemon outlives the short-lived hook), bound to this project's `.claude/monitors/` + a
  **project-scoped** socket/db (derived from the workspace path; reuses existing socket-path
  resolution); records the socket path in `.local.md`; and **registers this session**
  (`session.open` with `$CLAUDE_CODE_SESSION_ID` + `$CLAUDE_PROJECT_DIR`).
- **SessionEnd hook** → deregisters the session; the daemon **idle-reaps** itself after a grace
  period (default ~5 min) once its last session closes.

### 4.3 Why "drop a file → live" actually holds (no restart)

The standard plugin caveat — _hook changes require a Claude Code restart_ — does **not** bite us,
because the plugin's hooks are **fixed and generic** (boot / deliver / reap); they never change
per-monitor. A new monitor file is **data the daemon re-scans live**, not a hook change. So dropping a
monitor mid-session is picked up by the daemon's next scan and surfaces at the next turn-boundary
hook — no restart. (A restart is only ever needed if the plugin's _own_ hooks change, which is rare.)
This property is first-class and must be preserved by any implementation.

## 5. Observe layer

The daemon scans `.claude/monitors/` (flat `*.md` **and** `<dir>/MONITOR.md`) and runs
`file-fingerprint`. **v1 uses the existing `observe()` poll on the daemon tick** (already works);
the `watch()` fs-events path (already built as runtime execution, no bundled source uses it yet) is
the **real-time upgrade**, slotted in later without changing anything above it. Events materialize
and project into the registered session exactly as today.

## 6. Delivery layer (hooks baseline, channel upgrade)

Hooks are the deterministic baseline that works everywhere; the channel is the org-gated real-time
upgrade. Both reuse the existing claim path.

- **PreToolUse hook** (= the `turn-interruptible` lifecycle in the adapter mapping) → reads
  `.local.md` for the socket, calls `agentmonitors hook claim`, and injects pending events + each
  monitor's **body** as context, so the agent sees the work _and its instructions_ before its next
  tool call.
- **Stop hook** → the idle/turn-ended surface for lower-urgency items.
- Hook commands are thin and **degrade gracefully**: if the daemon is unreachable they no-op
  (SessionStart should have booted it).
- **Channel MCP** (the plugin's `.mcp.json`) → real-time between-turn push when the host supports
  channels. Org-gated, so never the baseline.

Reuse: `hook claim` IPC, the adapter lifecycle→Claude-hook mapping
(`turn-interruptible`→`PreToolUse`, `session-opened`→`SessionStart`, `turn-ended`→`Stop`, …), event
projection, hook-state.

## 7. Handling

No `handling` field in v1. The **body carries intent** ("FYI files changed" vs "Review the diff and
fix issues") better than an enum would. A handling/notify-vs-act field is only added if a concrete
thread proves the body insufficient (per the Tiered, per-thread rule).

## 8. Generalization to thread #2 (spec-sync)

Thread #2 is the smallest possible delta on this spine:

- **Same source** (`file-fingerprint` watching the spec files).
- **+ Multi-session fan-out:** deliver to _all_ peer lead sessions in the workspace, not just one —
  which stresses the current lead-only projection rule and likely needs the runtime to project to
  every active lead session for the workspace, **excluding the author** (the session whose edit
  produced the change).
- **+ One per-thread frontmatter field:** delivery **targeting/fan-out** (e.g. who this reaches),
  introduced and named when thread #2 is built.

It is sequenced second precisely because it isolates exactly one new hard thing (fan-out) on top of a
proven spine.

## 9. What's reused vs net-new

**Reuse:** daemon + socket IPC, `session.open`, projection, hook-state, `hook claim`, the adapter
lifecycle→hook mapping; `file-fingerprint` (observe); the `watch()` execution path; the channel
transport; the existing socket-path/db resolution.

**Net-new (the gaps this thread closes):**

1. Flat-file authoring (scanner + ID derivation).
2. Leaner schema: `name`/`event-kind` no longer required; **`event-kind` removed** (+ column/filter
   - exported types).
3. The colocated `aipm` marketplace + the `agentmonitors` activation plugin (`hooks/claude.yaml`,
   `.mcp.json`, setup skill, generated registries, CI `aipm validate`).
4. Lazy daemon boot (detached) + idle reaping + `.claude/agentmonitors.local.md` coordination.
5. The turn-boundary delivery hook that injects the monitor body as context.

## 10. Open implementation checkpoints

- **Detached daemon boot from a hook** — spawning a long-lived process from a short-lived hook
  reliably (portability across shells/OSes). Riskiest net-new bit; gets an explicit UAT.
- **Claude Code context-injection contract** — confirm the exact field/format for injecting context
  from `PreToolUse` vs `UserPromptSubmit` before building the delivery hook.
- **aipm plugin capability** — confirmed: plugins carry `hooks/claude.yaml` + `.mcp.json` (the
  toolkit's own template and the `marketplace-authoring` skill document both).

## 11. Testing

- **Steel-thread UAT (defines "done"):** a temp repo + a dropped monitor file + one-time plugin
  install → simulate a SessionStart and a turn-boundary → assert the agent's context receives the
  pending event **and** the monitor's body-instructions. The literal "drop a file → agent reacts"
  loop, automated.
- **Channel upgrade:** reuse the **MCP-client-as-host UAT pattern** from `experiments/channel-uat`
  (drive `channel serve` over stdio as the MCP host and assert the `<channel>` push).
- **Lower layers:** unit tests for flat-file scanning + ID derivation and the schema change
  (including a negative test that `event-kind` is rejected/ignored per the chosen removal semantics);
  integration tests for lazy boot + reaping and the delivery hook round-trip.

## 12. Non-goals (YAGNI)

- No always-on user-level service (per-project lazy daemon only).
- No speculative delivery/handling frontmatter — fields land per-thread.
- No webhook/push source in this thread (thread #6 builds on the `watch()` path later).
- No multi-session fan-out in this thread (thread #2).

## 13. Success criteria

A developer, in a repo with the plugin installed once, drops
`.claude/monitors/watch-src.md` and — with no further setup and no restart — the agent is told, with
that file's instructions, the next time `src/**/*.ts` changes, and acts. Proven by the §11 UAT.

## Decisions (from the brainstorm)

1. First steel thread: **local file watch**, then spec-sync.
2. Activation: **one-time hook lazily boots a project-scoped daemon**.
3. File completeness: **Tiered** (lean required core + optional fields), introduced **per-thread**.
4. `event-kind`: **removed** (tags + changeKind + urgency cover it).
5. On-disk shape: **flat file, promote to folder**.
6. Delivery: **hooks baseline + channel upgrade**.
7. Activation distribution: **colocated `aipm` marketplace plugin** (multi-host incl. Codex).
