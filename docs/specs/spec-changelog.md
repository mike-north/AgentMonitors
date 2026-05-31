# Spec Changelog

This file records clarifications, contradiction resolutions, and structural changes to the
Agent Monitors spec set in `docs/specs/`.

## Usage

- Add entries when ambiguity is resolved or the intended contract changes.
- Prefer short entries tied to the numbered doc affected.
- If implementation behavior and desired behavior differ, say so explicitly.

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
  restrictive CSP / Workers-style environments. Minor `@mike-north/core` changeset.

## 2026-05-31 — Duplicate monitor IDs are now rejected (G1)

- Promoted [001 §4](./001-monitor-definition.md) from target to **current**: duplicate
  folder-derived monitor IDs are now a hard error, closing roadmap item G1.
- `scanMonitors` surfaces collisions via a new `ScanResult.duplicateIds`
  (`DuplicateMonitorId[]`) field; the runtime tick refuses to run on duplicates; `validate`
  exits non-zero and `scan` reports them. Enforces SP2. Regression tests added at the scanner,
  runtime, and CLI layers; minor `@mike-north/core` changeset included.

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
