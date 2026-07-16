# 005 — CLI Reference

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md), [002-runtime-delivery.md](./002-runtime-delivery.md), [003-source-plugins.md](./003-source-plugins.md)
> **Covers:** the `agentmonitors` command surface — purpose, arguments, flags, output shape, and current-vs-target status of every command

---

## §1 Overview

The binary is named **`agentmonitors`** and is described as _"Durable observation and inbox delivery for AI agents"_. `--version` is never a hardcoded literal — `apps/cli/src/index.ts`'s `getVersion()` reads it from the CLI package's own `package.json` at runtime, so it always tracks the published release. Do not record a specific version value here; it will drift.

Per AP6, all public CLI behaviour must be derivable from core contracts. The CLI wraps `@agentmonitors/core` and five bundled source packages (`@agentmonitors/source-file-fingerprint`, `@agentmonitors/source-api-poll`, `@agentmonitors/source-command-poll`, `@agentmonitors/source-schedule`, `@agentmonitors/source-incoming-changes`).

### Output formats (`--format`)

Structured-output commands — `events list`, `scan`, `monitor history`, `monitor explain`, and `source list` — support three output formats via `--format`:

| Value  | Description                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toon` | TOON (Token-Oriented Object Notation) — a compact, human-readable encoding optimised for agent context windows. Losslessly encodes the same data model as JSON with ~40% fewer tokens for typical monitor output shapes. Uses `@toon-format/toon` `encode()`. |
| `json` | JSON (`JSON.stringify(value, null, 2)`). **Byte-for-byte unchanged** — always produces identical output to the pre-toon behaviour. All existing JSON consumers and tests are unaffected.                                                                      |
| `text` | Human-readable plain text (columnar tables, one record per line). Intended for interactive terminal use by authors.                                                                                                                                           |

**Default (auto-detect):** when `--format` is omitted, the CLI detects whether it is running inside an agentic TUI (agent context) or an interactive human terminal, and selects the appropriate format automatically:

- **Agent detected** → `toon`. Detection is powered by `is-agentic-tui`, which inspects well-known environment variables set by Claude Code (`CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT`), Cursor (`CURSOR_AGENT=1`), Gemini CLI (`GEMINI_CLI=1`), and others.
- **Human (interactive terminal)** → `text`.
- An explicit `--format` flag **always wins** and bypasses detection.

**Design invariants:**

- TOON is a **terminal rendering transform only** — durable storage (SQLite `monitor_events`, snapshots, source state, hook-state files) and the daemon IPC wire remain JSON everywhere.
- `--format json` is never changed. TOON support is purely additive from a JSON consumer's perspective.
- TOON round-trips losslessly: `decode(encode(value))` equals the original JSON value. Tests assert this property for every structured-output command.

### In-process vs. socket commands

Commands divide into two transport modes:

| Mode                                   | Commands                                                                                                                                                       | Mechanism                                                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **In-process** (no socket)             | `init`, `validate`, `scan`, `monitor test`, `source list`, `schema generate`, `inbox *`, `daemon once`                                                         | Operates directly on the filesystem and/or SQLite database. No daemon socket required.                                                                                          |
| **Daemon socket** (Unix domain socket) | `daemon run`, `daemon status`, `daemon stop`, `session open/close/list`, `events list/ack`, `hook claim`, `hook deliver`, `monitor history`, `monitor explain` | Sends JSON-RPC-style messages over a Unix domain socket via `callDaemon()` in `daemon-ipc.ts`.                                                                                  |
| **Daemon (agent-facing, _target_)**    | `snapshot`, `diff`, `summary`, `watch`, `inspect` (§14)                                                                                                        | Round-trip the daemon; transport (loopback HTTP vs the Unix socket) is an implementation detail ([007 §2.3](./007-agent-facing-interaction.md)). Read-only or declaration-only. |

**`daemon once` is notable:** although it lives under the `daemon` command group, its implementation in `runtime-client.ts` (`daemonTickClient`) calls `createRuntime()` and `runtime.tick()` directly without using the socket. It is a single-tick in-process run, not a socket call. This is consistent with [002-runtime-delivery.md](./002-runtime-delivery.md).

**`monitor history` and `monitor explain` are socket-first but degrade gracefully:** both round-trip the daemon socket when one is reachable, but on a genuine connection failure they fall back to reading the persisted SQLite store **in-process** (via `daemonStatus`-style `createRuntime()` calls — `listObservationHistoryInProcess` / `explainMonitorInProcess` in `runtime-client.ts`). This keeps read-only diagnosis working after `daemon once` with no daemon running (#150). See their sections in §6 for the banner and remediation semantics.

### Socket path resolution

The base daemon socket path is resolved in this priority order (implemented in `daemon-ipc.ts`):

1. `--socket <path>` CLI flag (where present)
2. `AGENTMONITORS_SOCKET` environment variable
3. `<dbDir>/agentmonitors.sock` (defaults to `~/.local/share/agentmonitors/agentmonitors.sock`)

If the resolved path exceeds 100 characters (Unix socket limit), it falls back to `/tmp/agentmonitors-<sha256-prefix>.sock`.

Manual daemon commands that operate on the active project — `session open`, `session close`,
`session list`, `events list`, `events ack`, `hook claim`, `doctor`, `daemon status`, `daemon
stop`, `monitor history`, and `monitor explain` — insert the enabled workspace's socket between
steps 2 and 3 via `resolveManualDaemonSocketPath()` in `manual-daemon.ts`. With no `--socket` and
no `AGENTMONITORS_SOCKET`, they read `.claude/agentmonitors.local.md` from the command workspace
(`--workspace` for `session open`/`doctor`/`monitor explain`/`monitor history`; otherwise
`CLAUDE_PROJECT_DIR` when set, then the process cwd). If that file has `enabled: true`, the command
uses **either** the persisted `socket:` value (if one has been written, e.g. by a lazily-booted
daemon) **or**, when nothing has persisted one yet, the derived per-workspace socket
(`workspacePaths()` — issue #335). Outside an enabled workspace, the global default in step 3 is
unchanged.

**`monitor history` and `monitor explain` unified with `doctor`/`daemon status`/`session open`
(issue #374):** before this fix, both commands resolved their socket via the bare `resolveSocketPath()`
global default, bypassing `resolveManualDaemonSocketPath()` entirely — so a daemon booted for the
current workspace (e.g. lazily by a Claude Code session) was invisible to `monitor history`/`monitor
explain` unless `--socket` was passed explicitly, even though `doctor`/`daemon status` could see it
flagless from the same directory. Both commands, and their no-daemon in-process SQLite fallback
(`explainMonitorInProcess`/`listObservationHistoryInProcess` in `runtime-client.ts`), now resolve the
same workspace-scoped socket and db (`resolveWorkspaceDbPath()` in `workspace-db-path.ts`) that
`doctor` uses — keyed off `--workspace` (defaulting to the process cwd, same as `doctor`). For `monitor
history`, `--workspace` already existed as an opt-in row filter (issue #345/#307); it now also
selects which workspace's daemon/db to reach, since the workspace whose history you asked for is also
the daemon you want to reach.

**`daemon run`/`daemon once` themselves resolve their bind/read socket and db the same way** (issue
#335): with no `--socket`/`AGENTMONITORS_DB`/`AGENTMONITORS_SOCKET` overrides, an enabled workspace
binds to its persisted-or-derived per-workspace socket/db, not the bare global default — so a
directly-invoked `daemon run` (as the Getting Started guide instructs) always agrees with `doctor`,
`session open`/`list`, and `daemon status`/`stop` about which daemon and which durable state they are
each looking at. See §9.1–§9.2 and §15.

When those manual daemon commands cannot reach the resolved socket, they report a single actionable
stderr line that says no daemon is running for this workspace, tells the author to start one with
`agentmonitors daemon run` or let the plugin start it automatically when a Claude Code session
opens, and points at `agentmonitors doctor` for the full workspace-health picture (issue #331 —
`NO_WORKSPACE_DAEMON_MESSAGE` in `apps/cli/src/manual-daemon.ts`). They exit non-zero and do not
expose a raw `DaemonConnectionError` stack trace. Daemon-side application errors are still surfaced
as normal command errors and, where a command supports `--format json`, still use the command's
JSON error shape.

### Database path resolution

The SQLite inbox database is resolved in this priority order (implemented in `db-path.ts` for the
bare global default, and `workspace-db-path.ts`'s `resolveWorkspaceDbPath()` for every
workspace-aware command — `doctor`, `daemon run`, `daemon once`, `daemon status`'s in-process
fallback, and `session start`'s lazy boot):

1. `AGENTMONITORS_DB` environment variable — wins outright (tests/overrides)
2. An enabled workspace (`.claude/agentmonitors.local.md` has `enabled: true`): the persisted `db:`
   value if one has been written, else the derived per-workspace db (`workspacePaths()` — SHA-256 hash
   of `resolve(workspacePath)` under `XDG_DATA_HOME ?? ~/.local/share/agentmonitors/workspaces/<hash>/`)
3. A not-enabled workspace (no project-scoped daemon to isolate to): the shared global default,
   `~/.local/share/agentmonitors/inbox.db`

Prior to issue #335, step 2 applied only to `doctor` and `session start`'s lazy boot; `daemon
run`/`daemon once` invoked directly (with no overrides) always used step 3 regardless of whether the
workspace was enabled, so they wrote to a different SQLite file than `doctor` read from.

> Note: no `--db` flag is exposed at the top-level program; `resolveDbPath()` accepts an optional
> override argument but it is not wired to a commander option in the current codebase.

---

## §2 `init` — Bootstrap the project, or scaffold a monitor

**Source:** `apps/cli/src/commands/init.ts`
**Status:** Fully implemented

### Purpose

`init` has two forms, selected by whether a `<name>` argument is present:

- **`init <name>`** — the **scaffold** form. Creates a new monitor directory under a base directory and writes a template `MONITOR.md` for the chosen observation source. Behavior is unchanged from prior releases.
- **`init`** (no name) — the **bootstrap** form. A one-shot project onboarding that enables monitoring, fixes `.gitignore`, optionally scaffolds a first monitor, validates the result, and prints a next-steps summary. This automates the manual steps previously documented only in the `setup-monitors` skill, so time-to-first-signal no longer requires reading docs.

### Usage

```
agentmonitors init [name] [options]
```

| Argument / Flag     | Type                  | Default               | Description                                                                                                                                                                                                                                        |
| ------------------- | --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[name]`            | positional (optional) | —                     | Monitor name, becomes the subdirectory name. **Omit to run the project bootstrap** instead of scaffolding one monitor.                                                                                                                             |
| `--dir <dir>`       | option                | `.claude/monitors`    | Base directory for monitors                                                                                                                                                                                                                        |
| `--type <type>`     | option (choices)      | `file-fingerprint`    | Observation source type: `file-fingerprint`, `api-poll`, `command-poll`, `schedule`, `incoming-changes`                                                                                                                                            |
| `--enable-only`     | boolean               | —                     | Bootstrap only: enable the project and fix `.gitignore`, then stop (no monitor, no prompts)                                                                                                                                                        |
| `--yes`             | boolean               | —                     | Bootstrap non-interactively: accept defaults and scaffold a starter monitor without prompting                                                                                                                                                      |
| `--glob <pattern>`  | option (repeatable)   | —                     | Scaffold form only. Seeds `watch.globs` (`file-fingerprint`) or `watch.paths` (`incoming-changes`), value-preserving; rejected for any other `--type`                                                                                              |
| `--command <token>` | option (repeatable)   | —                     | Scaffold form only. Seeds `watch.command` argv for `--type command-poll`, **one argv token per flag** (order-preserving, no shell/whitespace splitting); rejected for any other `--type`                                                           |
| `--name <name>`     | option                | derived from `[name]` | Scaffold form only. Seeds the frontmatter `name:` field, value-preserving (distinct from the positional `[name]`, which sets the directory). Omit to derive a readable form of `[name]` (see below) instead of the template's literal placeholder. |
| `--urgency <level>` | option (choices)      | —                     | Scaffold form only. Seeds the frontmatter `urgency:` field: `low`, `normal`, `high`                                                                                                                                                                |

`--enable-only` and `--yes` are only meaningful for the bootstrap form; when a `<name>` is given, `init` takes the scaffold path and those two flags are ignored. `--type` applies to both forms: it selects the scaffolded monitor's source type in the scaffold path, and (when `--yes` scaffolds a starter monitor) overrides the bootstrap form's default source type. `--glob`/`--command`/`--name`/`--urgency` are consumed only by the scaffold form; the bootstrap form accepts but ignores them (non-goal — bootstrap behavior is unchanged, issues #330, #388).

### Scaffold form (`init <name>`)

Human-readable only (no `--format` flag). Byte-for-byte unchanged by the bootstrap addition **when no seed flag is passed**, except for the trailing `doctor` pointer (issue #331) and the `verify` pointer (issue #408; see below).

- **Success:** prints `Created monitor: <dir>/<name>/MONITOR.md` followed by a hint to run `agentmonitors validate <dir>` and `agentmonitors doctor`, then a line recommending `agentmonitors verify <name> --dir <dir>` to prove the monitor delivers end-to-end — with `--manual` appended for any `--type` other than `file-fingerprint` (issue #408; `verify`'s auto-trigger, [§16](#16-verify--prove-a-monitor-delivers-end-to-end), only fabricates a change for `watch.globs`-based sources today).
- **Failure (duplicate):** prints to stderr `Monitor already exists: <dir>/<name>/MONITOR.md`; exits with code 1.
- **Failure (unsupported seed):** `--glob` on a `--type` with no path-pattern list in its template (`api-poll`, `command-poll`, `schedule`) prints to stderr `--glob is not supported for --type <type> (only file-fingerprint and incoming-changes have a path-pattern list)`; exits with code 1. No directory is created. `--command` on any `--type` other than `command-poll` prints to stderr `--command is not supported for --type <type> (only command-poll has a command: argv array)`; exits with code 1. No directory is created.

#### Seed flags (`--glob`, `--command`, `--name`, `--urgency`)

Each seed flag, when passed, replaces the corresponding field in the chosen `--type`'s template with the value given — value-preserving, not byte-for-byte: `--name`/`--glob`/`--command` values are re-emitted as single-quoted YAML scalars. The rest of the template (comments, other fields, body) is unchanged. `--glob` is repeatable (`--glob a --glob b` seeds a two-entry list) and is only meaningful for the two source types whose template has a path-pattern list: it writes `watch.globs` for `file-fingerprint` and `watch.paths` for `incoming-changes` (the field name differs per source; see [001 §2](./001-monitor-definition.md)). Values are re-emitted as single-quoted YAML scalars (`'` doubles to `''`), so arbitrary text — including embedded quotes, colons, or `#` — round-trips safely through `validate`. A scaffold with seed flags applied still passes `agentmonitors validate` (same as the zero-flag template).

#### Command-poll scaffold (`--command` and the untouched-default warning)

`command-poll`'s `watch.command` is an argv array run directly with **no shell** (spec [003 §"command-poll"](./003-source-plugins.md)); it is the entire intent of the monitor, and — unlike `file-fingerprint`'s `globs:` — there is no universally-sensible default. `--command` is repeatable and seeds that argv **one token per flag, order-preserving**: `--command git --command status --command --porcelain` yields `command: [git, status, --porcelain]`. Each token is emitted as a single-quoted YAML scalar, so a leading-dash token (`--porcelain`), embedded spaces, `#`, or `:` round-trip verbatim; the CLI never whitespace-splits a value, so it never invents shell semantics the source doesn't have. For a pipeline, seed a shell explicitly (`--command sh --command -c --command 'git status -sb | grep ahead'`). `--command` is rejected for any other `--type` (see the unsupported-seed failure above).

When `--command` is **omitted**, the scaffold keeps its illustrative upstream-tip default (`git ls-remote origin refs/heads/main`) so the monitor still validates and runs. Because that default validates and runs, a scaffold left untouched silently watches the wrong thing for any other intent (issue #388). To keep that from passing as if configured, **`validate` emits a soft, non-fatal warning** for a `command-poll` monitor whose `watch.command` still equals the exact untouched default (see [§3](#3-validate--validate-monitor-files)). The warning does not mark the monitor invalid or change the exit code; if polling the upstream branch tip is the real intent, it is safe to ignore.

**`--name` default (issue #375).** Unlike `--glob`/`--urgency`, `name:` is _always_ seeded on the scaffold path — never left as the template's literal placeholder. When `--name` is omitted, the value derives from the positional `[name]`: its `-`/`_`-separated segments are joined with spaces and the first segment is capitalized (e.g. `watch-docs` → `Watch docs`; `watchdocs` → `Watchdocs`). `--name` overrides this derivation with its own value, verbatim.

### Bootstrap form (`init`)

Runs against the current working directory. Performs, in order:

1. **Enable the project.** If `.claude/agentmonitors.local.md` does not already declare `enabled: true`, writes it with the minimal enable shape from the `setup-monitors` skill (`enabled: true` plus the "safe to delete" coordination-state note). An already-enabled file is left untouched so a re-run never clobbers socket/db fields a prior `session start` persisted.
2. **Fix `.gitignore`.** Ensures `.gitignore` contains the line `.claude/*.local.*` — appends it (creating the file if absent) when missing; a no-op when already present. Never duplicated across runs.
3. **Offer a first monitor.** Interactively (only on a TTY, and only when neither `--yes` nor `--enable-only` is given) prompts for a source type and monitor name, then scaffolds it through the same path as `init <name>`. `--yes` scaffolds the default monitor (`file-fingerprint`, name `my-monitor`, overridable with `--type`) with no prompt. `--enable-only` skips this step. A non-interactive invocation (non-TTY stdin) without `--yes` never prompts or hangs: it skips scaffolding and tells the caller to pass `--yes` or use `init <name>`.
4. **Validate.** When a monitor was scaffolded, runs the `validate` command in-process against the monitors directory and prints its result.
5. **Summarize.** Prints a "what happens next + how to verify" summary: automatic startup is conditioned on the Claude Code plugin being present ("If you're using the AgentMon Claude Code plugin, monitoring starts automatically the next time you open a Claude Code session"), with the manual `agentmonitors daemon run` alternative stated on the very next line for any other host or bare-terminal setup (issue #338 item 3 — the prior unconditional "starts automatically" phrasing overpromised outside Claude Code); a one-shot `daemon once` check; a pointer to `agentmonitors doctor` as the health-check next step (issue #331 — `doctor` is otherwise undiscoverable outside `--help`); and — when a monitor was created — how to verify it fires: `monitor test` for a dry-run, and `agentmonitors verify <name> --dir <dir>` (with `--manual` for any non-`file-fingerprint` type) as the real, CLI-only, one-command proof that it delivers end-to-end ([§16](#16-verify--prove-a-monitor-delivers-end-to-end)). The `setup-monitors` skill's "Verify It Fires" section is still named as a plugin-only supplement, never the sole pointer — a no-plugin/no-docs CLI user must not dead-end there (issue #408). The idempotent "nothing to change" re-run summary carries the same `doctor` pointer.

**Idempotency:** re-running the bootstrap on an already-enabled project whose `.gitignore` is correct (and, for `--yes`, whose default monitor already exists) changes nothing and prints an "already set up — nothing to change" message. Exits 0.

**Exit codes:** exits 0 on success (including a no-op re-run). Scaffold-form duplicate errors still exit 1.

### Templates

Each source produces a distinct starter frontmatter block:

| Source             | Key config fields in template                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `file-fingerprint` | `globs: ['**/*.ts']`                                                                                               |
| `api-poll`         | `url`, `method: GET`, `interval: 5m`; `change-detection.strategy` omitted so the source infers from `Content-Type` |
| `command-poll`     | `command: [git, ls-remote, origin, refs/heads/main]`, `interval: 5m`, `change-detection.strategy: text-diff`       |
| `schedule`         | `cron: '0 9 * * 1-5'`, `timezone: UTC`                                                                             |
| `incoming-changes` | `paths: ['docs/specs/**']`, `branch: main`                                                                         |

---

## §3 `validate` — Validate monitor files

**Source:** `apps/cli/src/commands/validate.ts`
**Status:** Fully implemented — validates each monitor's watch config (the `watch` block minus `type`) against the source's full JSON Schema (via the core `validateScope` helper). See [004-validation-testing.md](./004-validation-testing.md) §2.2.

### Purpose

Validates all `MONITOR.md` files found in a directory: checks that each monitor references a known source and that the source config inside `watch:` is fully valid against the source's `scopeSchema` (types, enums, `required`, `items`, …), and that monitor IDs are unique within the tree.

### Usage

```
agentmonitors validate [path] [options]
```

| Argument / Flag     | Type                  | Default            | Description                   |
| ------------------- | --------------------- | ------------------ | ----------------------------- |
| `[path]`            | positional (optional) | `.claude/monitors` | Path to monitors directory    |
| `--format <format>` | option (choices)      | `text`             | Output format: `text`, `json` |

### Output

**Text format:**

```
Valid monitors: <n>
  <id>: <name>
...

Invalid monitors: <n>
  <id>: <error message>
...

Warnings: <n>
  <id>: <warning message>
...
```

Both valid and invalid monitor lines use the monitor ID (the folder/stem name) as the identifier.
If the ID cannot be derived from the path (unusual), the full file path is used as a fallback.

The optional **Warnings** section carries soft, non-fatal advisories about monitors that are
otherwise **valid** — it never changes the valid/invalid counts or the exit code, and is omitted when
there are none. Current warnings:

- **Untouched command-poll scaffold (issue #388):** a `command-poll` monitor whose `watch.command`
  still equals the exact `init --type command-poll` default (`git ls-remote origin refs/heads/main`)
  is flagged, because it validates and runs but silently watches the wrong thing for any intent other
  than upstream-tip polling. Seed the intended command with `init … --command …`, or edit
  `watch.command`; the warning is safe to ignore when the upstream-tip probe is intentional. See
  [§2](#2-init--bootstrap-the-project-or-scaffold-a-monitor).

If no monitors are found: prints `No monitors found.`

If a file path (rather than a directory) is passed: prints an error to stderr naming
`agentmonitors monitor test` as the symmetric command for single-file testing, and exits 1
(`monitor test` redirects the other direction for a directory argument — §6).

**JSON format (`--format json`):**

```json
{
  "valid": <number>,
  "invalid": <number>,
  "monitors": [
    { "id": "<string>", "name": "<string>", "source": "<string>" }
  ],
  "duplicateIds": [{ "id": "<string>", "filePaths": ["<string>"] }],
  "errors": [
    { "filePath": "<string>", "error": "<string>" }
  ],
  "warnings": [{ "id": "<string>", "warning": "<string>" }]
}
```

`warnings` is additive (issue #388): an array of `{ id, warning }` for otherwise-valid monitors, `[]`
when none apply. It never affects `valid`/`invalid` or the exit code. Consumers that ignore unknown
keys are unaffected.

(In text output, each invalid monitor is labelled by its monitor ID. In JSON output, the
`errors[].filePath` field carries the monitor ID as its value; the key name `filePath` is
preserved for backward compatibility with existing JSON consumers. `duplicateIds` is the raw
scan-level collision list — same shape as `scan`'s `duplicateIds` (§4) — and is `[]` when there are
no collisions; each duplicate ID is additionally folded into `errors` as an invalid-monitor entry,
so `invalid`/`errors` already reflect the duplicate without requiring a consumer to cross-reference
`duplicateIds`.)

### Validation logic (current)

1. Parses all `MONITOR.md` files via `scanMonitors()` from `@agentmonitors/core` (parse errors are included in `errors`).
2. Checks each monitor's `watch.type` field against the built-in `SourceRegistry`; unknown sources produce an error listing available sources.
3. Validates each monitor's `watch` config (minus `type`) against the source's full `scopeSchema` (draft-07) via the exported core `validateScope` helper — types, enums, `required`, `items`, and other keywords, not just field presence.
4. Rejects duplicate monitor IDs within the scanned tree (see [001 §4](./001-monitor-definition.md)).
5. If a parse failure appears to use the pre-migration top-level `source:` + `scope:` shape, appends a hint to rewrite it as `watch: { type, ... }`.

### Exit codes

Exits with code 1 if any monitor is invalid. Exits 0 if all monitors pass (or if no monitors are found).

---

## §4 `scan` — Discover and summarise monitors

**Source:** `apps/cli/src/commands/scan.ts`
**Status:** Fully implemented

### Purpose

Finds and lists all `MONITOR.md` files in a directory without performing validation.

### Usage

```
agentmonitors scan [dir] [options]
```

| Argument / Flag     | Type                  | Default            | Description                           |
| ------------------- | --------------------- | ------------------ | ------------------------------------- |
| `[dir]`             | positional (optional) | `.claude/monitors` | Directory to scan                     |
| `--format <format>` | option (choices)      | auto (see §1)      | Output format: `toon`, `json`, `text` |

### Output

**Text format:** a columnar table with headers `ID`, `Name`, `Source`, `Urgency` (column widths 30, 40, 20, open). If parse errors occurred, appends `<n> file(s) failed to parse.`

If no monitors and no errors: prints `No monitors found.`

**TOON format (`--format toon`):** encodes the same data model as the JSON format using `@toon-format/toon` `encode()`. Decodes losslessly back to the identical JSON value.

**JSON format (`--format json`):**

```json
{
  "monitors": [
    {
      "id": "<string>",
      "name": "<string>",
      "source": "<string>",
      "urgency": "<string>",
      "tags": ["<string>"],
      "notify": "<string | null>"
    }
  ],
  "errors": [{ "filePath": "<string>", "error": "<string>" }],
  "duplicateIds": [{ "id": "<string>", "filePaths": ["<string>"] }]
}
```

Note: `tags` defaults to `[]` when absent; `notify` defaults to `null` when absent; `duplicateIds` is `[]` when no collisions exist. Each entry carries the colliding monitor `id` (derived from the folder name) and the `filePaths` of all `MONITOR.md` files that derive that id (at least two).

### Exit codes

Always exits 0 (parse errors are reported informatively, not as failures).

---

## §5 `inbox` — Manage inbox items

**Source:** `apps/cli/src/commands/inbox.ts`
**Status:** Fully implemented

### Purpose

Query and transition inbox items in the local SQLite database. All subcommands operate in-process (no daemon socket required).

### §5.1 `inbox list`

```
agentmonitors inbox list [options]
```

| Flag                  | Type     | Default | Description                                                                 |
| --------------------- | -------- | ------- | --------------------------------------------------------------------------- |
| `--state <state>`     | choices  | —       | Filter: `queued`, `acked`, `in-progress`, `completed`, `failed`, `archived` |
| `--urgency <urgency>` | choices  | —       | Filter: `low`, `normal`, `high`                                             |
| `--tags <tags>`       | string   | —       | Comma-separated tag filter                                                  |
| `--monitor <id>`      | string   | —       | Filter by monitor ID                                                        |
| `--since <date>`      | ISO 8601 | —       | Items created after this date                                               |
| `--until <date>`      | ISO 8601 | —       | Items created before this date                                              |
| `--format <format>`   | choices  | `text`  | `text`, `json`                                                              |

**Text output:** one line per item: `[<state>] <id>  <title>  (<urgency>)`

**JSON output:** raw `InboxItem[]` array serialised via `JSON.stringify`.

**Validation:** `--since` and `--until` are validated with `new Date()`; invalid dates call `reportError` and return without querying.

### §5.2 `inbox ack`

```
agentmonitors inbox ack <id>
```

Transitions item from `queued` → `acked`. Prints `Acknowledged: <id>` on success. On error prints to stderr and exits 1.

### §5.3 `inbox start`

```
agentmonitors inbox start <id>
```

Transitions item to `in-progress`. Prints `Started: <id>` on success.

### §5.4 `inbox complete`

```
agentmonitors inbox complete <id>
```

Transitions item to `completed`. Prints `Completed: <id>` on success.

### §5.5 `inbox fail`

```
agentmonitors inbox fail <id> [--error <message>]
```

| Flag                | Type   | Default | Description                               |
| ------------------- | ------ | ------- | ----------------------------------------- |
| `--error <message>` | string | —       | Optional error message stored on the item |

Transitions item to `failed`. Prints `Failed: <id>` on success.

### §5.6 `inbox archive`

```
agentmonitors inbox archive <id>
```

Transitions a `completed` or `failed` item to `archived`. Prints `Archived: <id>` on success.

### Exit codes for inbox transitions

All transition subcommands (`ack`, `start`, `complete`, `fail`, `archive`) print to stderr and set exit code 1 when the transition fails (e.g., invalid state machine transition or item not found).

---

## §6 `monitor test` — Dry-run an observation source

**Source:** `apps/cli/src/commands/monitor-test.ts`
**Status:** Fully implemented

### Purpose

Reads a single `MONITOR.md` file, resolves its source, and runs a live observation cycle to verify configuration without writing to the database. For stateful sources (`source.stateful === true`), automatically runs a second observation after 100 ms to demonstrate change detection.

### Usage

```
agentmonitors monitor test <path> [options]
```

| Argument / Flag     | Type                  | Default | Description                        |
| ------------------- | --------------------- | ------- | ---------------------------------- |
| `<path>`            | positional (required) | —       | Path to a single `MONITOR.md` file |
| `--format <format>` | choices               | `text`  | Output format: `text`, `json`      |

### Output

**Text format:**

- Prints `Testing monitor "<name>" (source: <sourceName>)...`
- If a source reports `outcome: "no-files-matched"` (currently `file-fingerprint` when its
  scope expands to zero files), prints an error naming `watch.globs` / `watch.cwd` and does not
  establish a baseline or run the second observation.
- For stateful sources with no first-run observations: prints baseline message, runs second observation, then either prints observations or explains no changes were detected.
- Prints observation titles and snapshots.
- If a directory (rather than a single file) is passed: prints an error to stderr naming
  `agentmonitors validate` as the symmetric command for a whole directory, and exits 1 — instead of
  a raw `EISDIR` read error (issue #338 item 6; the shared `requireFile()` helper mirrors
  `validate`'s own `requireDirectory()` file-vs-directory redirect, §3).

**JSON format (`--format json`):**

```json
{
  "monitor": "<name>",
  "source": "<sourceName>",
  "baseline": <boolean>,
  "observations": [
    { "title": "<string>", "snapshot": <any> }
  ]
}
```

`baseline: true` indicates the JSON result is from the second (post-baseline) observation.

When a source reports `outcome: "no-files-matched"`, JSON output is:

```json
{
  "monitor": "<name>",
  "source": "<sourceName>",
  "baseline": false,
  "outcome": "no-files-matched",
  "observations": [],
  "error": "<message>"
}
```

**Error output:** Uses `reportError()` — JSON `{ "error": "<message>" }` to stdout when `--format json`; `Error: <message>` to stderr otherwise. The `no-files-matched` diagnostic uses the structured JSON shape above for `--format json` and the same `Error: <message>` stderr convention for text. Exits 1.

### Exit codes

Exits 1 on: file not found, parse error, unknown source, observation exception, or
`no-files-matched`. Exits 0 on successful dry-run, including genuine quiet/no-change runs where the
source matched its scope.

### `monitor history` — Observation audit trail

**Status:** Fully implemented (socket with a no-daemon in-process DB fallback).

Lists the per-tick outcomes the runtime records for each due monitor
([002 §"Persistence Schema"](./002-runtime-delivery.md)) — useful for answering "why didn't my
monitor fire?". Round-trips through the daemon socket (`history.list`) when a daemon is reachable,
auto-discovering the **same per-workspace socket** `doctor`/`daemon status`/`session open` use
(issue #374, `resolveManualDaemonSocketPath()` — see "Socket path resolution" in §1) — no `--socket`
flag is required to reach a daemon already running for the current workspace.

**No-daemon fallback (#150):** observation history is read-only durable state, so if the daemon is
unreachable (a genuine connection failure — socket refused/absent or request timeout) the command
reads the persisted SQLite store **in-process**, from the same workspace-resolved db (issue #374),
instead of erroring. When it returns rows, text output is prefixed with the banner _"No daemon
running — showing persisted state from the last tick."_ (the `--format json` array is unchanged).
When the daemon is down **and** there are no persisted rows, it prints an actionable remediation
line, exits 1, rather than a raw Node `connect ENOENT …`. The wording depends on whether the
workspace is actually enabled — i.e. whether `resolveManualDaemonSocketPath()` really derived a
workspace-scoped socket, or the probe fell through to the bare global default (issue #374 review
follow-up: the message must not claim workspace scoping that never happened):

- **Enabled workspace:** _"No daemon running for this workspace and no persisted state to show.
  Start it with `agentmonitors daemon run` (or it starts automatically when a Claude Code session
  opens); if the daemon you want lives at a different socket, point at it with `--socket <path>`.
  Or use `agentmonitors monitor test <path>` for a one-shot check."_
- **Not enabled** (no workspace scoping occurred): _"No daemon running at the default socket and no
  persisted state to show. Start it with `agentmonitors daemon run`, enable this workspace so its
  socket is auto-discovered (`agentmonitors init --enable-only`), or point at the daemon you want
  with `--socket <path>`. Or use `agentmonitors monitor test <path>` for a one-shot check."_

A daemon-side **application** error (the daemon answered with an error) is still surfaced verbatim
as `History failed: <message>`, never masked as "daemon not running" (the #94/#98 distinction
holds).

```
agentmonitors monitor history [monitorId] [--socket <path>] [--workspace <path>] [--limit <n>] [--format <toon|text|json>]
```

| Argument / Flag      | Default             | Description                                                                                                                     |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `[monitorId]`        | —                   | Filter to a single monitor id                                                                                                   |
| `--socket <path>`    | resolved default    | Unix domain socket path for the daemon                                                                                          |
| `--workspace <path>` | current working dir | Opt-in row filter to one workspace's history (issue #345/#307) — also selects which workspace's daemon/db to reach (issue #374) |
| `--limit <n>`        | `50`                | Maximum rows (newest first)                                                                                                     |
| `--format`           | auto (see §1)       | `toon`, `text` (one row per line), or `json`                                                                                    |

Each row reports `result` — `triggered` (≥1 observation became an event), `suppressed` (observations
returned but none emitted this tick), `no-change` (the source returned nothing), `no-files-matched`
(a file-system source matched zero files), `errored` (the source's `observe()` or its `ingest()`
threw; the failure was isolated so other monitors still ran — see
[002 §`observation_history`](./002-runtime-delivery.md)), or `rebaselined` (the source advanced its
baseline without computing a delta, e.g. after a force-pushed/gc'd ref; distinct from `no-change`) —
plus the monitor id, source name, and timestamp.

### `monitor explain` — Pipeline diagnosis

**Status:** Fully implemented (socket with a no-daemon in-process DB fallback).

Diagnoses where a single monitor's signal currently stops. The command asks the daemon for a
read-only staged report (`monitor.explain`) built from the monitor definition, scheduling state,
recent `observation_history`, `monitor_state.notify_state`, `monitor_events`, and
`session_event_state` projection rows. Auto-discovers the **same per-workspace socket**
`doctor`/`daemon status`/`session open` use (issue #374, `resolveManualDaemonSocketPath()` — see
"Socket path resolution" in §1) — no `--socket` flag is required to reach a daemon already running
for the current workspace.

```
agentmonitors monitor explain <monitorId> [--dir <path>] [--workspace <path>] [--socket <path>] [--history-limit <n>] [--event-limit <n>] [--format <toon|text|json>]
```

| Argument / Flag       | Default             | Description                                                                                       |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| `<monitorId>`         | —                   | Monitor id to diagnose                                                                            |
| `--dir <path>`        | `.claude/monitors`  | Directory containing monitor definitions                                                          |
| `--workspace <path>`  | current working dir | Workspace path used for session projection, and (issue #374) which workspace's daemon/db to reach |
| `--socket <path>`     | resolved default    | Unix domain socket path for the daemon                                                            |
| `--history-limit <n>` | `10`                | Observation history rows included in structured output                                            |
| `--event-limit <n>`   | `10`                | Materialized event rows included in structured output                                             |
| `--format`            | auto (see §1)       | `toon`, `text` (stage summary), or `json` (full report)                                           |

Text output prints one line per stage with a status glyph, followed by a verdict:

- `✓` — `ok` (stage produced its signal)
- `○` — `healthy` (the stage ran and the correct outcome was "nothing to do" — e.g. the watched
  target genuinely hasn't changed; an idle monitor is not a bug)
- `⏳` — `pending` (intentionally holding, e.g. debounce/throttle, or upstream hasn't produced input)
- `✗` — `failure` (a real fault: invalid definition, errored observe, missing projection, daemon
  down)

A genuinely idle monitor therefore renders `○` at the observation stage with an affirmative verdict
(e.g. "Source ran, observed 0 changes — your watched target genuinely hasn't changed (not a bug)."),
never `✗`. JSON output returns:

```json
{
  "monitorId": "<id>",
  "generatedAt": "<iso timestamp>",
  "monitor": {
    "id": "<id>",
    "displayName": "<name>",
    "filePath": "<path>",
    "sourceName": "<source>",
    "urgency": "low|normal|high"
  },
  "stages": [
    {
      "id": "definition|scheduling|observation|notify|materialization|delivery",
      "label": "<display label>",
      "status": "ok|pending|healthy|failure",
      "reason": "<one-line reason>",
      "details": {}
    }
  ],
  "verdict": {
    "status": "ok|pending|healthy|failure",
    "stage": "definition|scheduling|observation|notify|materialization|delivery",
    "reason": "<one-line reason>"
  },
  "observations": [],
  "events": [],
  "projections": [],
  "leadSessions": []
}
```

**Verdict severity ranking**: the verdict reflects the _highest-severity_ stage, not the first
non-`ok` stage. The severity order is `failure` > `pending` > `healthy` > `ok`. A `healthy` or
`ok` observation stage never masks a downstream `failure` or `pending` (#149). A fully idle
monitor (all stages `healthy`) reports a `healthy` verdict.

**No-daemon fallback (#150):** if the daemon is not reachable (a genuine connection failure — socket
refused/absent or request timeout), `monitor explain` runs the **same** `explainMonitor` in-process
against the persisted SQLite store — the same workspace-resolved db (issue #374, `resolveWorkspaceDbPath()`)
`doctor` reads — exactly as `daemon once` runs a tick in-process. A read-only diagnosis tool must not
require a live daemon: the data from the last tick is already in the DB.
**Crucially, a daemon connection failure is NOT itself reported as a stage `failure`** — unlike the
pre-#150 behaviour which fabricated a `✗ Scheduling: failure` verdict, the in-process path runs the
full pipeline read and produces real stage statuses from persisted state.

The report is rendered according to three cases:

- **Definition failure** (parse error, monitor not found, duplicate ID, unknown source): the report
  is shown as-is — no no-daemon banner, since there is no persisted state involved; the definition
  failure is the complete diagnosis. Exits 0.
- **Definition ok, persisted state exists** (`observation_history` or `monitor_events` rows present):
  the real per-stage diagnosis is shown, prefixed with the banner _"No daemon running — showing
  persisted state from the last tick."_ (text) or annotated with a `"notice"` field alongside the
  full report (JSON). Exits 0.
- **Definition ok, nothing persisted** (no history, no events — the daemon never ran): an actionable
  remediation line is printed instead of a raw Node `connect ENOENT …`, and exits 1. As with
  `monitor history` above, the wording depends on whether the workspace is actually enabled (issue
  #374 review follow-up):
  - **Enabled workspace:** _"No daemon running for this workspace and no persisted state to show.
    Start it with `agentmonitors daemon run` (or it starts automatically when a Claude Code session
    opens); if the daemon you want lives at a different socket, point at it with `--socket <path>`.
    Or use `agentmonitors monitor test <path>` for a one-shot check."_
  - **Not enabled:** _"No daemon running at the default socket and no persisted state to show. Start
    it with `agentmonitors daemon run`, enable this workspace so its socket is auto-discovered
    (`agentmonitors init --enable-only`), or point at the daemon you want with `--socket <path>`. Or
    use `agentmonitors monitor test <path>` for a one-shot check."_

A daemon-side **application** error (the daemon answered with an error) is **not** masked as "daemon
not running": it is surfaced verbatim as `Explain failed: <message>` with exit code 1. Malformed
command arguments remain normal CLI errors.

---

## §7 `source` — Manage observation source plugins

**Source:** `apps/cli/src/commands/source.ts`
**Status:** `list` is fully implemented; `search`, `install`, `update`, `remove` are **placeholders — not implemented** (NP3).

### §7.1 `source list`

```
agentmonitors source list [--format <format>]
```

| Flag                | Type    | Default       | Description            |
| ------------------- | ------- | ------------- | ---------------------- |
| `--format <format>` | choices | auto (see §1) | `toon`, `json`, `text` |

Lists all sources registered via `registerCoreSources()` (currently: `file-fingerprint`,
`api-poll`, `command-poll`, `schedule`, `incoming-changes`).

**TOON format (`--format toon`):** encodes the source list using `@toon-format/toon` `encode()`.
It carries the same fields as the JSON value below; `fieldDescriptions` is rendered as
`{ field, description }` rows so long descriptions with bracketed examples round-trip cleanly.

**Text output (`--format text`):**

```
Installed sources:

  <name>
    Config fields: <field1>, <field2>, ...
    - <field1>: <description>
    Required: <field1>, ... (or "(none)")
```

**JSON output (`--format json`):**

```json
[
  {
    "name": "<string>",
    "configFields": ["<string>"],
    "scopeFields": ["<string>"],
    "fieldDescriptions": { "<field>": "<description>" },
    "required": ["<string>"]
  }
]
```

`scopeFields` remains as a backwards-compatible JSON alias for existing consumers. New users should read `configFields`; these are fields written flat inside `watch:` alongside `type`, not under a `scope:` key.
`fieldDescriptions` is additive metadata derived from each source's JSON Schema `description` and
rendered as plain terminal-safe text.

### §7.2 `source search` — placeholder

```
agentmonitors source search [query]
```

Prints to stderr:

```
Plugin search is not yet implemented. (query: "<query>")
Install plugins manually: pnpm add --prefix ~/.config/agentmonitors <package-name>
```

Exits 1.

### §7.3 `source install` — placeholder

```
agentmonitors source install <name>
```

Prints to stderr:

```
Plugin installation is not yet implemented: <name>
Install manually: pnpm add --prefix ~/.config/agentmonitors <name>
```

Exits 1.

### §7.4 `source update` — placeholder

```
agentmonitors source update [name]
```

Prints to stderr:

```
Plugin update is not yet implemented. (package: <name>)
```

Exits 1.

### §7.5 `source remove` — placeholder

```
agentmonitors source remove <name>
```

Prints to stderr:

```
Plugin removal is not yet implemented: <name>
```

Exits 1.

---

## §8 `schema` — JSON Schema management

**Source:** `apps/cli/src/commands/schema.ts`
**Status:** Fully implemented

### §8.1 `schema generate`

```
agentmonitors schema generate [-o <file>]
```

| Flag                  | Type   | Default | Description                                   |
| --------------------- | ------ | ------- | --------------------------------------------- |
| `-o, --output <file>` | string | —       | Write schema to file; omit to print to stdout |

Calls `generateMonitorSchema(registry.list())` from `@agentmonitors/core` and outputs the resulting JSON schema (pretty-printed with 2-space indent).

- **Without `--output`:** prints schema JSON to stdout.
- **With `--output <file>`:** writes to file and prints `Schema written to <file>`.

### Exit codes

Exits 0 on success. No explicit error handling; filesystem errors propagate as uncaught exceptions.

---

## §9 `daemon` — Runtime loop management

**Source:** `apps/cli/src/commands/daemon.ts`
**Status:** Fully implemented

### §9.1 `daemon once` — Single in-process tick

```
agentmonitors daemon once [monitorsDir] [options]
```

| Argument / Flag      | Type                  | Default            | Description                                                                                          |
| -------------------- | --------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `[monitorsDir]`      | positional (optional) | `.claude/monitors` | Directory containing `MONITOR.md` files                                                              |
| `--workspace <path>` | string                | `process.cwd()`    | Workspace path for session projection and per-workspace db resolution (resolved to an absolute path) |
| `--format <format>`  | choices               | `text`             | `text`, `json`                                                                                       |

**Transport: in-process.** `daemonTickClient` calls `createRuntime(dbPath).tick()` directly — no daemon socket is contacted. `dbPath` is resolved via `resolveWorkspaceDbPath()` (see "Database path resolution" above) — for an enabled workspace this is the persisted-or-derived per-workspace db, not the bare global default, so `daemon once`'s writes are visible to `doctor` and every other workspace-aware command (issue #335).

**Text output:** `Evaluated <n> monitor(s), emitted <n> event(s).` — when one or more monitors'
`observe()` errored on the tick, the summary instead ends with `, <k> errored:` followed by one
indented `  <monitorId>: <message>` line per errored monitor (so a silently-swallowed source error
is not hidden behind a clean `emitted 0`). When nothing errored the line is unchanged, ending with
`.`, so a genuine no-change tick stays clean.

When one or more monitors were found but skipped because they are not yet due, the summary is
extended with a parenthetical suffix: `(<n> not yet due — next due in <s>s)`, where `<s>` is the
number of seconds until the soonest-due skipped monitor. The wording is intentionally generic so
it is accurate for both interval-based monitors (file-fingerprint, api-poll) and schedule monitors
whose cron window has not yet opened. This makes a second `daemon once` run within a monitor's
next-due window distinguishable from "no monitors found" — the two situations previously produced
identical output (issue #152).

The default per-monitor observe interval for `file-fingerprint` and `command-poll` is 30 seconds;
for `api-poll` it is 5 minutes. Authors may override with `watch.interval: <duration>` in the
`MONITOR.md` frontmatter. This observe interval is distinct from daemon `--poll-ms`: `--poll-ms`
is only how often the daemon wakes up to ask the runtime whether any monitor is due.

**JSON output (`--format json`):** the raw `RuntimeTickResult` object:

```json
{
  "evaluatedMonitors": ["<monitorId>", ...],
  "emittedEventIds": ["<eventId>", ...],
  "erroredObservations": [{ "monitorId": "<monitorId>", "message": "<error>" }, ...],
  "skippedMonitors": [{ "monitorId": "<monitorId>", "nextDueAt": "<iso8601>" }, ...]
}
```

### §9.2 `daemon run` — Continuous loop

```
agentmonitors daemon run [monitorsDir] [options]
```

| Argument / Flag        | Type                  | Default            | Description                                                                                                 |
| ---------------------- | --------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `[monitorsDir]`        | positional (optional) | `.claude/monitors` | Directory containing `MONITOR.md` files                                                                     |
| `--workspace <path>`   | string                | `process.cwd()`    | Workspace path for session projection and per-workspace db/socket resolution (resolved to an absolute path) |
| `--poll-ms <ms>`       | number (string)       | `30000`            | Polling interval in milliseconds                                                                            |
| `--socket <path>`      | string                | resolved default   | Unix domain socket path for the daemon                                                                      |
| `--reap-after-ms <ms>` | number (string)       | `300000`           | Stop after this many ms with no active sessions; `0` disables idle reaping                                  |

Starts the daemon loop: creates a Unix domain socket server, listens for IPC commands, then polls `runtime.tick()` at `--poll-ms` intervals. `--poll-ms` is the loop-wake cadence; per-monitor observation is still gated by each monitor's schedule or `watch.interval`.

**Db/socket resolution (issue #335):** with no `--socket`/`AGENTMONITORS_DB`/`AGENTMONITORS_SOCKET`
override, an enabled workspace binds to its persisted-or-derived per-workspace socket and db (the
same `resolveManualDaemonSocketPath()`/`resolveWorkspaceDbPath()` every other workspace-aware command
uses) rather than the bare global default. This is what makes a directly-invoked `daemon run` — the
Getting Started guide's own documented usage, with no flags beyond `[monitorsDir]` — agree with
`doctor`, `session open`/`list`, and `daemon status` about the workspace's durable state.

**Startup check:** refuses to start if another daemon is already listening at the resolved socket path (exits with error message and code 1).

**Signal handling:** `SIGINT` and `SIGTERM` trigger a graceful stop (closes the socket, exits the loop).

**Idle reaping:** after each tick, counts active sessions for the workspace. If none have been active continuously for `--reap-after-ms` ms, the daemon stops itself. Disabled when `--reap-after-ms 0`.

**Stdout per tick (when events emitted _or_ one or more monitors errored):**
`Emitted <n> event(s) from <n> monitor(s).` — when one or more monitors' `observe()` errored, the
line ends with `, <k> errored:` followed by one indented `  <monitorId>: <message>` line per errored
monitor. A tick that neither emits nor errors logs nothing (no per-tick noise), but an errored
monitor is never silent.

**Tick errors** that fail the whole tick (not a single monitor's `observe()`) are logged to stderr as `AgentMon runtime tick failed: <message>` but do not stop the loop.

### §9.3 `daemon status`

```
agentmonitors daemon status [options]
```

| Flag                | Type    | Default          | Description                            |
| ------------------- | ------- | ---------------- | -------------------------------------- |
| `--socket <path>`   | string  | resolved default | Unix domain socket path for the daemon |
| `--format <format>` | choices | `text`           | `text`, `json`                         |

No `--workspace` flag: like `hook claim`/`events list`, the socket resolution below is workspace-aware
via `CLAUDE_PROJECT_DIR`/the process cwd, not an explicit flag (issue #335 — previously `daemon
status` used only `--socket`/the bare global default, so it could disagree with `doctor`/`session
list` about a workspace-scoped daemon they could already see). If the daemon is reachable (socket
`ping` succeeds, resolved via `resolveManualDaemonSocketPath()` the same way `doctor` resolves it),
queries status via the socket. Otherwise falls back to calling
`createRuntime(resolveWorkspaceDbPath(...)).status()` in-process against the same per-workspace
database `doctor` would read.

**Text output:**

```
Daemon running: yes|no
Socket: <path>
Sessions: <n>
Active sessions: <n>
Dormant sessions: <n>
Events: <n>
```

**JSON output:**

```json
{
  "running": <boolean>,
  "socketPath": "<string>",
  "sessions": <number>,
  "activeSessions": <number>,
  "dormantSessions": <number>,
  "events": <number>
}
```

### §9.4 `daemon stop`

```
agentmonitors daemon stop [--socket <path>]
```

| Flag              | Type   | Default          | Description                            |
| ----------------- | ------ | ---------------- | -------------------------------------- |
| `--socket <path>` | string | resolved default | Unix domain socket path for the daemon |

Resolves the socket the same workspace-aware way `daemon status` does (issue #335). Sends a `stop` message to the daemon over the socket. Prints `AgentMon daemon stopping.` on success. On error, calls `reportError` to stderr and exits 1.

---

## §10 `session` — Manage agent sessions

**Source:** `apps/cli/src/commands/session.ts`
**Status:** Fully implemented. All subcommands route through the daemon socket.

### §10.1 `session open`

```
agentmonitors session open --host-session-id <id> [options]
```

| Flag                       | Type              | Default                   | Description                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--host-session-id <id>`   | string (required) | —                         | Host session id from the integrating runtime                                                                                                                                                                                                                     |
| `--workspace <path>`       | string            | current working directory | Workspace path for the session; resolved to an absolute path (`path.resolve()`) the same way `doctor`/`daemon once`/`daemon run` resolve theirs (issue #335), so a relative or trailing-slash value cannot silently fail `doctor`'s exact-string workspace match |
| `--socket <path>`          | string            | resolved default          | Unix domain socket path                                                                                                                                                                                                                                          |
| `--agent-identity <id>`    | string            | —                         | Explicit AgentMon agent identity                                                                                                                                                                                                                                 |
| `--hook-state-path <path>` | string            | —                         | Override hook-state file path                                                                                                                                                                                                                                    |
| `--role <role>`            | choices           | `lead`                    | `lead`, `subagent`                                                                                                                                                                                                                                               |
| `--format <format>`        | choices           | `text`                    | `text`, `json`, `id`                                                                                                                                                                                                                                             |

Calls `claudeCodeAdapter.createSessionInput()` before sending to the daemon (`session.open` IPC method).

**Text output:**

```
Opened session: <session.id>
Agent identity: <session.agentIdentity>
Hook state: <session.hookStatePath>
```

**JSON output:** full `AgentSessionRecord` object.

**`--format id` output:** just `<session.id>` — no surrounding text, no JSON envelope. Added
(issue #338 item 4) so verification recipes that only need the AgentMon session id for later
commands don't need a hand-rolled JSON-parsing one-liner:

```bash
AGENTMON_SESSION_ID=$(agentmonitors session open --host-session-id "$HOST_ID" --format id)
```

### §10.2 `session close`

```
agentmonitors session close <sessionId> [options]
```

| Argument / Flag     | Type                  | Default          | Description             |
| ------------------- | --------------------- | ---------------- | ----------------------- |
| `<sessionId>`       | positional (required) | —                | AgentMon session id     |
| `--socket <path>`   | string                | resolved default | Unix domain socket path |
| `--format <format>` | choices               | `text`           | `text`, `json`          |

Marks the session dormant (`session.close` IPC method).

**Text output:** `Closed session: <session.id>`

**JSON output:** full `AgentSessionRecord` object.

### §10.3 `session list`

```
agentmonitors session list [options]
```

| Flag                | Type    | Default          | Description             |
| ------------------- | ------- | ---------------- | ----------------------- |
| `--socket <path>`   | string  | resolved default | Unix domain socket path |
| `--format <format>` | choices | `text`           | `text`, `json`          |

**Text output:** one line per session: `<id>  <status>  <agentIdentity>  <workspacePath | "(global)">`

**JSON output:** `AgentSessionRecord[]` array.

### §10.4 `session start` — Lazy-boot daemon and register session

```
agentmonitors session start
```

No flags. Like `hook deliver`, this command is hook-invoked and reads its context from the **Claude
Code hook payload on stdin** (a JSON object — there is **no `CLAUDE_CODE_SESSION_ID` env var**; see
006 §5.0). If stdin is a TTY or empty/unparseable, the payload is `{}`.

| Payload field | Description                                                               |
| ------------- | ------------------------------------------------------------------------- |
| `session_id`  | Host session id (required; quiet no-op if absent — not a Claude session)  |
| `cwd`         | Workspace path (falls back to `CLAUDE_PROJECT_DIR`, then `process.cwd()`) |

**Behavior:**

0. Reads the hook payload from stdin. `hostSessionId = session_id`; if absent, exits silently (not a Claude session).
1. Reads `.claude/agentmonitors.local.md` in the workspace. If absent or `enabled: false`, exits silently (quick-exit).
2. Derives per-workspace socket/db paths via `workspacePaths()` (overridden by `socket`/`db` fields in the local state file if present).
3. If no daemon is listening at the socket, spawns `daemon run` as a **detached background process** (`stdio: 'ignore'`, `.unref()`), passing the derived socket/db paths, the monitors dir, and `reap-after-ms` from the local state. Waits up to 8 seconds for the socket to appear.
4. Persists the resolved socket/db paths back to `.claude/agentmonitors.local.md` (so sibling hooks can use them without re-deriving).
5. Opens a session via the `session.open` IPC method (`claudeCodeAdapter.createSessionInput()` with `hostSessionId` and `workspacePath`).
6. **Surfaces the post-compact recap in the same process.** `SessionStart` is a context event, and a Claude Code hook invocation provides only **one** stdin stream — so the recap cannot be a separately chained `hook deliver` (it would see an already-consumed stdin and no-op; see 006 §5.6). Reusing the payload it already read, `session start` claims `post-compact` for the session and, if there are unread events, prints the rendered `SessionStart` hook JSON (`{ "continue": true, "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "…" } }`) to stdout.

**Output:**

- **Nothing pending** (a fresh start with no unread events) → **no output**.
- **Compact-resume with unread events** → the `SessionStart` recap JSON on stdout (the `additionalContext` carries the unread events' bodies). This is the only `session …` subcommand that emits hook-wire JSON, so its stdout MUST stay clean (wire JSON only).

**Exit code (two layers):**

- The **CLI command** exits **0** on a quick-exit (no `session_id`, or monitoring not enabled) and on success (with or without recap output). A genuine failure — the daemon not starting within the boot timeout, or a `session.open`/`claimDelivery` error — is reported to **stderr** and exits **non-zero** (`reportError(…, false)` sets `process.exitCode = 1`).
- The **plugin hook wrapper** (`agent-plugins/agentmonitors/hooks/hooks.json`) runs the command as `agentmonitors session start || true`, so the **hook invocation** is best-effort from Claude Code's perspective — a CLI failure never disrupts the session. The best-effort property is the wrapper's, not the command's.

**Designed for use as a `SessionStart` hook** (see 006 §5.6). Claude Code does not need the daemon to be pre-started.

### §10.5 `session end` — Deregister session

```
agentmonitors session end
```

No flags. Reads the same stdin hook payload as `session start` (`session_id` + `cwd`; **not** env
vars).

**Behavior:**

0. Reads the hook payload from stdin. `hostSessionId = session_id`; if absent, exits silently.
1. Reads `.claude/agentmonitors.local.md`. If absent, `enabled: false`, or no `socket` field, exits silently.
2. If the daemon is unreachable, exits silently.
3. Calls `session.list` to find the runtime session whose `hostSessionId` matches the payload's `session_id`, then calls `session.close` on it.

After all sessions for a workspace are closed, the daemon's idle reaper will stop it within `reap-after-ms`.

**Designed for use as a `Stop` hook** in Claude Code.

---

## §11 `events` — Query or acknowledge runtime events

**Source:** `apps/cli/src/commands/events.ts`
**Status:** Fully implemented. All subcommands route through the daemon socket.

### §11.1 `events list`

```
agentmonitors events list --session <id> [options]
```

| Flag                  | Type                | Default          | Description                                          |
| --------------------- | ------------------- | ---------------- | ---------------------------------------------------- |
| `--session <id>`      | string (required)   | —                | AgentMon session id                                  |
| `--socket <path>`     | string              | resolved default | Unix domain socket path                              |
| `--monitor <id>`      | string              | —                | Filter by monitor id                                 |
| `--urgency <urgency>` | choices             | —                | `low`, `normal`, `high`                              |
| `--tag <tag>`         | string (repeatable) | `[]`             | Filter by tag; may be specified multiple times       |
| `--scope <pairs>`     | string              | —                | Scope filters as `key=value,key2=value2`             |
| `--unread`            | boolean flag        | —                | Only unread events (unacknowledged — see note below) |
| `--since-baseline`    | boolean flag        | —                | Only events since the session baseline               |
| `--format <format>`   | choices             | auto (see §1)    | `toon`, `json`, `text`                               |

**`--unread` matches "unacknowledged," not "never seen" (002 §7; issue #338 item 1).** It filters
on `acknowledgedAt IS NULL`, which **includes** events already claimed at a delivery lifecycle but
not yet run through `events ack`. Each returned event's `deliveryState` field (see below)
disambiguates: `unread` (never surfaced), `claimed` (surfaced once, still unacknowledged), or
`acknowledged`.

**TOON output (`--format toon`):** encodes the `MonitorEventRecord[]` array using `@toon-format/toon` `encode()`. Decodes losslessly to the JSON value.

**Text output (`--format text`):** one line per event: `<id>  <monitorId>  <urgency>  <deliveryState>  <title>`

**JSON output (`--format json`):** `MonitorEventRecord[]` array. Each element carries a
`deliveryState?: 'unread' | 'claimed' | 'acknowledged'` field reporting the **requesting session's**
delivery state for that event (002 §7). Present only because this query is always session-scoped
(`--session` is required); a hypothetical unscoped `listEvents()` call in core has no single
session's state to report and leaves the field `undefined`.

**Scope parsing:** the `--scope` value is split on `,`, then each segment is split on `=` to build a `Record<string, string>`. Segments that cannot be parsed as `key=value` are silently dropped.

**Note on `--tag`:** this flag is repeatable (using a custom `collectTag` accumulator). Example: `--tag foo --tag bar` filters for events tagged with both `foo` and `bar`.

### §11.2 `events ack`

```
agentmonitors events ack --session <id> [options]
```

| Flag                | Type              | Default          | Description                                       |
| ------------------- | ----------------- | ---------------- | ------------------------------------------------- |
| `--session <id>`    | string (required) | —                | AgentMon session id                               |
| `--socket <path>`   | string            | resolved default | Unix domain socket path                           |
| `--event-ids <ids>` | string            | —                | Comma-separated event ids; omit to ack all unread |

Prints `Acknowledged events.` on success. No `--format` flag; error output goes to stderr.

---

## §12 `hook` — Claim hook-delivery payloads

**Source:** `apps/cli/src/commands/hook.ts`
**Status:** Fully implemented. Routes through the daemon socket.

### §12.1 `hook claim`

```
agentmonitors hook claim --session <id> --lifecycle <lifecycle> [options]
```

| Flag                      | Type               | Default          | Description                                                    |
| ------------------------- | ------------------ | ---------------- | -------------------------------------------------------------- |
| `--session <id>`          | string (required)  | —                | AgentMon session id                                            |
| `--socket <path>`         | string             | resolved default | Unix domain socket path                                        |
| `--lifecycle <lifecycle>` | choices (required) | —                | `turn-interruptible`, `turn-idle`, `post-compact`              |
| `--format <format>`       | choices            | `json`           | `text`, `json` — **default is `json`** (unique among commands) |

Claims a pending delivery payload for a session at the specified lifecycle point (`hook.claim` IPC method). Returns `null` if no delivery is pending.

**JSON output (default):**

```json
<DeliveryClaim object | null>
```

**Text output (`--format text`):**

- If no pending delivery: `No pending delivery.`
- If delivery present: prints `claim.message`.

---

### §12.2 `hook deliver`

```
agentmonitors hook deliver [--lifecycle <lifecycle>] [--format <format>] [--socket <path>] [--debug]
```

| Flag                      | Type    | Default          | Description                                                                                                                                |
| ------------------------- | ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--lifecycle <lifecycle>` | choices | derived          | Optional override (`turn-interruptible`, `turn-idle`, `post-compact`); normally derived from the firing event                              |
| `--format <format>`       | choices | hook wire JSON   | `json` emits the compact Claude Code hook object; `text` emits only the rendered `additionalContext` for manual inspection                 |
| `--socket <path>`         | string  | from `.local.md` | Override daemon socket path                                                                                                                |
| `--debug`                 | boolean | `false`          | Write a step-by-step diagnosis to **stderr** (issue #334); **stdout is byte-identical to a non-`--debug` run in every mode** — see §12.2.1 |

**Designed to run as a Claude Code lifecycle hook.** Reads the hook payload as **JSON on stdin**
(Claude Code delivers hook input via stdin, **not** env vars — there is no `CLAUDE_CODE_SESSION_ID`
env var). It uses `session_id`, `hook_event_name`, and `cwd` from the payload, claims pending
deliveries for that session, and emits them as **advisory, non-blocking `additionalContext`** at the
turn boundary. The lifecycle is derived from `hook_event_name`; the same command line works on every
event.

Emission requires an enabled project, an explicit per-workspace `socket:` in
`.claude/agentmonitors.local.md` (or `--socket`), a reachable daemon, and a tracked AgentMon session
whose `hostSessionId` matches the hook payload's `session_id`. Empty output means nothing is pending
or the workspace/session is not configured.

**Behavior:**

1. Read stdin as a JSON hook payload (TTY/empty/unparseable → `{}`; never hangs). If `session_id` is absent → exit 0, print nothing.
2. Derive the lifecycle from `hook_event_name` (unless `--lifecycle` is passed). Non-context events (`PreToolUse`, `Stop`) → exit 0, print nothing.
3. Read `.claude/agentmonitors.local.md` via `payload.cwd ?? CLAUDE_PROJECT_DIR ?? cwd`. If `!enabled` or no explicit socket → exit 0, print nothing.
4. Check daemon availability. If unreachable → exit 0, print nothing.
5. List sessions, find the one matching `session_id`. If not found → exit 0, print nothing on
   stdout; ALSO write `hook deliver: no session registered for host session id "<id>"` to
   **stderr**, unconditionally — not gated behind `--debug` (issue #329; see §12.2.1).
6. Call `claimDelivery(sessionId, lifecycle)`. If null → exit 0, print nothing.
7. Render via `renderHookDelivery(claim, hookEventName)`. It returns `null` (→ exit 0, print nothing) **only** when the claim is `null` or carries neither event bodies nor a reminder message. A `normal`/`low` claim with `events: []` but a populated `message` renders that message as a reminder line (see Note below) — it is **not** silent.
8. Print the selected output format to stdout and exit 0.

**ALWAYS exits 0.** Any internal error is swallowed to avoid interrupting the user's session. A hook
that exits non-zero can block tool calls.

**Default output and `--format json` (when there is something pending):** compact Claude Code hook
wire JSON. The example below is pretty-printed for readability; the command emits the compact
`JSON.stringify(output)` form on stdout.

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "AgentMon: monitored changes are pending — consider handling them before continuing.\n\n### watch-src (high)\n..."
  }
}
```

**Wire output (reminder only — a pending `normal`/`low` change, no body injection):**

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "AgentMon messages are available. Read the inbox."
  }
}
```

**No output** when nothing is pending (empty stdout + exit 0).

**Text output (`--format text`):** prints only the rendered
`hookSpecificOutput.additionalContext` string, with no JSON wrapper. This format is for manual
inspection; hook configurations should use the default/json wire output.

#### §12.2.1 `--debug` diagnosis (issue #334) and the always-on unknown-session warning (issue #329)

Empty stdout + exit 0 is the command's contract both when nothing is pending **and** when the stdin
payload is misconfigured (unknown session, workspace not enabled, urgency held) — indistinguishable
failure modes for the command most often run by an invisible hook system, and undiagnosable without
a flag (blind DX study S3 F3). `--debug` writes a parallel, step-by-step diagnosis to **stderr only**;
**stdout's contract does not change in any mode** — a hook wired without `--debug` behaves exactly as
before, and running the identical payload with and without `--debug` produces byte-identical stdout.

**The unresolved-`session_id` branch (§12.2 step 5) is the one exception, and does NOT require
`--debug`.** Every other branch below resolves itself (the ~15s high-urgency claim-settle window) or
is a genuinely idle, non-actionable state; an unresolvable `session_id` can never resolve, and its
silent empty output is exactly what issue #329 reported as indistinguishable from that legitimate
settle window. So step 5 always writes, unconditionally:

```text
hook deliver: no session registered for host session id "<id>"
```

to stderr — stdout and the exit code are unaffected. `<id>` comes from untrusted stdin, so it is
JSON-string-escaped — including DEL, the C1 controls (U+0080–U+009F), and the U+2028/U+2029
line/paragraph separators, which `JSON.stringify` alone leaves raw — so no control or
line-breaking code point can reach the terminal raw, and truncated at 128 characters — at a
code-point boundary, never splitting a surrogate pair — with a trailing `…`.
Every other quiet-return branch stays silent by default; use `--debug` for those.

Each `--debug` line is prefixed `agentmonitors hook deliver --debug:` for easy filtering (a
distinct, unprefixed line format from the always-on warning above). The diagnosis reports, in order:

1. The parsed stdin payload's `session_id` / `hook_event_name` / `cwd` (or `(none)` when absent).
2. Why resolution stopped, if it did — no `session_id`; an unmapped `hook_event_name` (§12.2 step 2);
   a disabled/misconfigured workspace (§12.2 step 3, the "cwd mismatch" symptom); no socket configured;
   an unreachable daemon; or no tracked session matching `session_id` (a workspace/session mismatch;
   this is the same branch that already warned on stderr unconditionally above — `--debug` adds the
   known-session count for extra context).
3. On successful resolution: the resolved AgentMon session id, workspace, and status.
4. **Unread (unacknowledged) event counts by urgency** — includes claimed-but-unacknowledged events — for the resolved session at the resolved lifecycle (a read-only
   query; never claims).
5. **Per-band hold reasons** for anything not yet deliverable, naming the mechanism:
   - `settle-window` — pending high-urgency events exist but none has aged past the 15s claim-time
     settle window yet (002 §9.1).
   - `already-claimed` / `coalesced-until-ack` — the coalesced normal/low reminder (002 §9.2/§9.3) is
     suppressed because some or all of the band's unread events are already claimed. This is the SAME
     vocabulary `monitor explain`'s reminder-suppression diagnosis uses (002 §10.7, issue #333), so the
     two surfaces agree on what to call it.
   - `deferred-by-cap` — settled high-urgency events existed but some were deferred by the transport's
     4000-char `additionalContext` cap (issue #299, §12.2's redelivery guarantee); they will redeliver
     at the next context event.
6. The actual `claimDelivery` result (mode/urgency/event count, or `null`).
7. Whether anything was emitted to stdout, and in which format.

Any internal error is still swallowed on stdout (the always-exit-0 contract, unchanged); in `--debug`
mode it is additionally named on stderr rather than silently disappearing.

**Lifecycle → urgency surfacing:**

| Lifecycle            | Derived from hook events          | Surfaced payload                                                                |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| `turn-interruptible` | `UserPromptSubmit`, `PostToolUse` | settled high-urgency event bodies; normal-urgency changes as reminder text only |
| `turn-idle`          | override only                     | low-urgency changes as reminder text only                                       |
| `post-compact`       | `SessionStart`                    | all unread event bodies as a recap                                              |

Note: for a derived `turn-interruptible` lifecycle, `normal` urgency produces `events: []` (reminder
only — no body injection); `low` does likewise at `turn-idle`. "Reminder only" is **not** silence:
the command emits a hook JSON object whose `additionalContext` is the claim's advisory `message`
(e.g. `"AgentMon messages are available. Read the inbox."` — the same line `hook claim` surfaces), so
a default (`normal`-urgency) monitor produces a visible mid-turn reminder. Body text is surfaced only
for **high-urgency settled events** and **`post-compact`** (`SessionStart`) recap. The claimed rows
are not acknowledged, so the event stays unread and re-discoverable via `events list --unread`.
Over-cap context is truncated at a code-point boundary with an explicit `[truncated …]` marker; the
truncated-away events stay unread (claiming ≠ acking) and are likewise re-discoverable.

See [006 §5](./006-agent-integration.md) for the full transport spec and hook registration examples.

---

## §13 `channel` — Claude Code channel server

**Source:** `apps/cli/src/commands/channel.ts`
**Status:** Two-way (push + `agentmon_ack` tool) implemented. Plugin packaging is the remaining
target work; see [006 §4](./006-agent-integration.md).

### `channel serve`

Runs AgentMon as a Claude Code **channel**: an MCP server (stdio) that pushes pending
turn-interruptible deliveries (settled high-urgency events, and coalesced normal reminders) into the
session as `<channel source="agentmonitors" …>` events. Intended to be spawned by Claude Code via a
channel plugin, not run by hand.

**Usage:** `agentmonitors channel serve [--socket <path>] [--poll-ms <ms>] [--host-session-id <id>] [--workspace <path>]`

- `--socket` — daemon Unix socket path. `channel serve` is spawned **automatically** by the
  plugin's `.mcp.json` (no flags at all — like a hook), so its precedence is _not_ the same as
  `resolveManualDaemonSocketPath` (issue #335), which the manually-typed `session`/`events`/`hook`/
  `daemon` commands use. Instead: an explicit `--socket` wins outright; otherwise an **enabled**
  `--workspace` (see below) uses its persisted-or-derived per-workspace socket — the same socket
  `session start` lazy-boots (issue #358) — **before** `$AGENTMONITORS_SOCKET`; only a not-enabled
  workspace falls back to `$AGENTMONITORS_SOCKET`, then the standard global-default path. This
  order is deliberately env-var-last for `channel serve`: because it has no interactive moment
  where a user deliberately sets `AGENTMONITORS_SOCKET`, a value left over from a different
  workspace must never win over the current, enabled workspace's own socket — doing so would
  either cross-connect the channel to another workspace's daemon (a session-isolation break) or
  land on a dead socket (reproducing issue #358's original symptom). This mirrors the isolation
  guarantee `hook deliver` already enforces (§12) by refusing to fall back past an enabled
  workspace's socket at all.
- `--poll-ms` — delivery poll interval in milliseconds (default: `3000`).
- `--host-session-id` — host session id (default: `$CLAUDE_CODE_SESSION_ID`).
- `--workspace` — workspace path (default: `$CLAUDE_PROJECT_DIR`).

**Behavior:** declares the `claude/channel` capability **and `tools`**, and connects over stdio. If a
host session id is available, it resolves the AgentMon session via `session.open` (idempotent) and,
every `--poll-ms`, calls `claimDelivery('turn-interruptible')`; each returned `DeliveryClaim` is
rendered into a `<channel>` event (006 §4.2). It also exposes the **`agentmon_ack`** tool: the agent
calls it with `event_ids` (or none, to ack all unread) and it routes through `events.ack` for the
bound session (006 §4.3). It reuses the claim path, so claimed-state and cross-transport dedup with
the hook-state surface are automatic. A missing/unreachable daemon is handled quietly (the hook-state
path still delivers durably); the server shuts down when stdin closes (MCP disconnect). With no host
session id it stays connected (the ack tool reports an error if called) but does not poll.

**Output:** none on stdout (the stdio channel is the MCP transport). Errors are quiet by design.

---

## §14 Agent-facing interaction & ephemeral monitors (_target_)

**Status:** **mostly target** — §14 specifies the agent-facing verbs greenlit in Epic #259. As of
Refs #312, **§14.4 `watch` is _current_** (see its own status line); §14.1–§14.3 and §14.5 remain
_target_ and do not ship today. Each **MUST** be moved to _current_, with `verified:` references, when
it ships (the semantic contract is [007](./007-agent-facing-interaction.md); retire the matching
[roadmap.md](./roadmap.md) gap at that time). These commands are **read-only or declaration-only** —
they never claim, acknowledge, advance a cursor, or trigger a fresh source observation
([007 §2.1](./007-agent-facing-interaction.md)). They round-trip the daemon (transport — loopback
HTTP vs the Unix socket — is an implementation detail, [007 §2.3](./007-agent-facing-interaction.md))
and support the standard `--format` shapes (§1). An agent invokes them **in response to a pushed
signal or at its own turn boundary**, never on a timer of its own (PP9).

### §14.1 `snapshot` — fetch the current stored snapshot

```
agentmonitors snapshot <monitorId> [--object <objectKey>] [--session <id>] [--socket <path>] [--format <format>]
```

Returns the latest stored `monitor_snapshots` text for `(workspacePath, monitorId, objectKey)` — the
same text the runtime diffs against — with **no** re-fetch of the underlying resource and **no**
delivery-state change ([007 §3.1](./007-agent-facing-interaction.md), SP5). When the monitor watches
exactly one object, `--object` may be omitted; when it watches several and `--object` is omitted, the
command lists the available object keys rather than guessing.

### §14.2 `diff` — diff one object between two points in time

```
agentmonitors diff <monitorId> --object <objectKey> [--from <point>] [--to <point>] [--session <id>] [--socket <path>] [--format <format>]
```

Computes a textual diff of one observed object between two stored points, each a durable event id or
an ISO-8601 timestamp (resolved to the snapshot at/just-before it). `--from` defaults to the
session's own baseline cursor; `--to` defaults to the latest snapshot — so a bare invocation answers
"what has changed for me since my baseline" ([007 §3.2](./007-agent-facing-interaction.md)). Uses the
runtime's `buildTextDiff` so agent-visible diffs match delivered diffs. A referenced point whose
snapshot has been pruned is a **clear error**, not an empty diff.

### §14.3 `summary` — lightweight payload orientation

```
agentmonitors summary <monitorId> [--object <objectKey>] [--session <id>] [--socket <path>] [--format <format>]
```

Returns a cheap orientation — monitor id, `objectKey`, urgency, `changeKind`, unread/claimed counts,
event `title`/`summary` — **without** the full snapshot or diff
([007 §3.3](./007-agent-facing-interaction.md)). The cheapest act-on-signal read.

### §14.4 `watch` — declare / list / cancel an ephemeral monitor

**Status:** **current** (Refs #312). Implemented on the same daemon/pipeline as a persistent monitor.
Verified: `apps/cli/src/commands/watch.ts` + `apps/cli/src/daemon-ipc.ts` (`watch.declare|list|cancel`)
→ `AgentMonitorRuntime.declareEphemeralMonitor`/`listEphemeralMonitors`/`cancelEphemeralMonitor`
([007 §4](./007-agent-facing-interaction.md)); the
`describe('ephemeral monitors: watch declare/list/cancel (007 §4 / 005 §14.4)')` suite in
`apps/cli/src/commands/cli.integration.test.ts`.

```
agentmonitors watch <source> --session <id> --scope <spec> [--urgency <u>] [--instruction <text>] [--display-name <name>] [--socket <path>] [--format <format>]
agentmonitors watch list --session <id> [--socket <path>] [--format <format>]
agentmonitors watch cancel <ephemeralId> --session <id> [--socket <path>] [--format <format>]
```

Declares an **ephemeral, session-scoped** monitor on the same daemon/pipeline as a persistent
`MONITOR.md` monitor (AP7, [007 §4](./007-agent-facing-interaction.md)) — "tell me when _X_, and
remind me of _this instruction_ when it does." `<source>` is a registered source name; `--scope` is
the source config as either `key=value,...` (scalar-valued) or a JSON object (for array/nested/typed
scopes, e.g. `--scope '{"globs":["src/**"]}'`). The scope is validated by the **same** shared core
helper (`validateWatchScope` — the `validateScope` schema check plus the BP3
`change-detection.collection` friendly wrapper) as `agentmonitors validate` (§3), so an ephemeral
monitor cannot express a config a persistent one could not, and an invalid scope is rejected with the
identical diagnosis (including the keyed-collection case). `--session` is the declaring AgentMon
session id and **MUST** name a **lead** session; an unbindable or non-lead declaration is
**rejected**, never silently made global (its events would never deliver — [007 §4.6](./007-agent-facing-interaction.md)).
The declaration **performs no watching**: it registers intent and returns; the daemon does all
observation/scheduling/notify/persist/project/deliver (PP9/PP10). Its events project into the
**declaring session only**, never a sibling lead session in the same workspace
([007 §4.6](./007-agent-facing-interaction.md)). The monitor is **reaped when its declaring session
ends or goes dormant** ([002 §6.2](./002-runtime-delivery.md)) and survives a daemon restart while the
session lives ([007 §4.4](./007-agent-facing-interaction.md)); `watch cancel` reaps it immediately and
only the owning session may cancel it. `watch <source>` is the default action, so `agentmonitors watch
schedule --session … --scope …` and `agentmonitors watch declare schedule …` are equivalent. (A
fire-condition `--until` flag — the seed of dependent chains, #124 — is **not** part of this primitive
and remains _target_; see [007 §8](./007-agent-facing-interaction.md).)

### §14.5 `inspect` — observability (received / pending / armed)

```
agentmonitors inspect [--session <id>] [--socket <path>] [--format <format>]
```

Returns, for a session, three **distinct** buckets in one read
([007 §5](./007-agent-facing-interaction.md)): **received** (delivered/acknowledged), **pending**
(unread — fired, waiting), and **armed-but-not-yet-fired** (a condition the daemon has detected but is
holding inside a settle/debounce/throttle/rollup window or a recorded `net`/Interpret suppression).
For each armed entry it reports the **hold reason** and, where deterministic, the **earliest time it
could fire** — so the agent learns "a change is coming and roughly when" **without polling**. A pure
read: `inspect` never claims, acks, or advances a cursor.

---

## §15 `doctor` — Unified workspace health check

**Source:** `apps/cli/src/commands/doctor.ts`
**Status:** Fully implemented (daemon-served report when reachable, in-process durable-state
fallback otherwise — issue #373).

### Purpose

Answers "is my monitoring working, and if not, where is it broken?" from one command, replacing the
ad-hoc stitching of `daemon status`, `monitor explain`, `events list`, and `session list` that the
[setup-monitors skill](../../agent-plugins/agentmonitors/skills/setup-monitors/SKILL.md) formalizes.
It runs a named sequence of checks for the current workspace and prints a per-monitor rollup.

**`doctor` diagnoses only — it never mutates state.** There is no `--fix` (a later issue may add
remediation). It does **not** check host-plugin installation (whether the Claude Code plugin is
installed is the host's side), and performs no MCP/channel checks. It never folds in or changes
`monitor explain`.

### Usage

```
agentmonitors doctor [--dir <path>] [--workspace <path>] [--socket <path>] [--format <text|json>]
```

| Flag                 | Default                        | Description                                                                                         |
| -------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `--dir <path>`       | `<workspace>/.claude/monitors` | Directory containing monitor definitions                                                            |
| `--workspace <path>` | current working dir            | Workspace to diagnose (session projection + event scoping); resolved to an absolute path            |
| `--socket <path>`    | resolved default               | Unix domain socket path for the `doctor.report` RPC (also doubles as the daemon-reachability check) |
| `--format <format>`  | `text`                         | Output format: `text`, `json`                                                                       |

### Transport and data source

`doctor` prefers the **live daemon's own connection** when one is reachable: it calls `doctor.report`
over the daemon socket (the same transport `monitor explain`/`monitor history` use), falling back to
an **in-process** read of the persisted SQLite store when the daemon is unreachable
(`DaemonConnectionError`) **or** when a reachable daemon answers that it does not understand the
request at all (`DaemonUnsupportedRequestError`) — mirroring `monitor explain`'s #150 no-daemon read
and `daemon status`'s in-process fallback. The latter case (issue #382) covers version skew: a still-
running daemon build that predates `doctor.report` (or any request method added after it shipped)
can only answer with the socket protocol's legacy unparseable-request sentinel
(`{ id: "invalid", error: "Invalid JSON request." }`, optionally paired with a newer daemon's
`code: "unsupported_request"`); `doctor` recognizes that sentinel precisely — never a loose
substring match, so a genuine daemon-side application error is never misclassified — and falls back
the same way it would for an unreachable daemon, rather than surfacing the raw sentinel text as a
fatal crash. This ordering is deliberate (issue #373): a separate reader connection opened
fresh against the same on-disk SQLite file as a live writer's connection can observe that writer's
commits with a lag — WAL visibility across processes is not the same immediacy guarantee as reads on
the writer's own connection — so an in-process-always read could freeze the per-monitor rollup
(`last-observed`, `last-event`, delivery counts) at a stale snapshot even while `events list`/`monitor
history`, served straight from the live daemon, already showed the current state. Routing through the
daemon when one is reachable means `doctor`'s rollup is read from the exact same connection that
materialized the data, eliminating that cross-connection lag; the in-process fallback remains correct
for the case there genuinely is no live daemon to ask (its own report is then read from the last
committed state, same as before). The database and socket are resolved for the workspace the same way
the daemon resolves them: `AGENTMONITORS_DB` / `AGENTMONITORS_SOCKET` win, then an enabled workspace's
persisted `.claude/agentmonitors.local.md` `db:` / `socket:` (or the derived per-workspace paths), then
the global defaults. As of issue #335, this is enforced symmetrically: `daemon run`/`daemon once` —
including a directly-invoked one with no flags beyond `[monitorsDir]`, exactly as the Getting Started
guide instructs — apply the identical resolution when binding, so `doctor`'s guess is never a _guess_
against a workspace-enabled project; it is guaranteed to be the daemon's actual db/socket. The
`daemon-reachable` check's pass/fail is now derived from whether the `doctor.report` call itself
reached the daemon (not a separate ping), so the check and the report source can never disagree about
whether the daemon was actually live.

### Checks

`doctor` runs this ordered sequence, printing one line per check with a `pass` (`✓`), `fail` (`✗`),
`skip` (`○`), or `idle` (`◇`) status and, on `fail`/`idle`, an actionable remediation:

| Check                | Passes when                                                    | Remediation on failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-enabled`    | `.claude/agentmonitors.local.md` has `enabled: true`           | Run `agentmonitors init --enable-only`, or create `.claude/agentmonitors.local.md` with `enabled: true` yourself — the **same** enable step the `SessionStart` monitors-found-but-disabled advisory names (006 §5.6, §2), so all three surfaces agree                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `monitors-directory` | the monitors directory exists                                  | Create the directory and scaffold a monitor with `agentmonitors init`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `monitors-valid`     | every discovered monitor validates (no scope/parse/dup errors) | Run `agentmonitors validate <dir>` and fix the reported errors (`skip` when there are no monitors)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `daemon-reachable`   | the `doctor.report` call reached a live daemon                 | Start it with `agentmonitors daemon run`, or let a Claude Code session start it automatically — `idle` when it doesn't and no lead session is registered (nothing is actually broken); **`fail`** when it doesn't but a lead session IS registered (issue #382 — an agent session is open with no daemon serving it, almost certainly a mid-session crash), see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `lead-session`       | a lead session is registered for this workspace                | Open a Claude Code session (the `SessionStart` hook runs `agentmonitors session start`, which lazy-boots the daemon and registers a lead session automatically); to do it by hand with no plugin, pipe a hook payload to that same command — `echo '{"session_id":"manual-cli-session","cwd":"<path>"}' \| agentmonitors session start`. It recommends `session start`, **not** `session open`, because `session open`'s `--host-session-id` is a required option with no meaningful value for a manual CLI user — a copy-pasted `session open` fails with `error: required option '--host-session-id' not specified` (issue #387). The failure `detail` and remediation both **name the exact workspace path searched** (issue #335), so a future db/socket-derivation mismatch is self-diagnosing: compare it directly against `agentmonitors session list`'s workspace column; `idle` (not `fail`) when no lead session is registered, see below |
| `monitor:<id>`       | the monitor is valid and has been observed at least once       | Start the daemon (or wait for the next tick), then check `agentmonitors monitor history <id>`; `monitor test` dry-runs it (`skip` for an invalid monitor — see `monitors-valid`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Each `monitor:<id>` line embeds the per-monitor rollup (below).

**Exit-code contract (issue #373, refined by #382).** `doctor` exits **0** when every check is `pass`,
`skip`, or `idle`, and **non-zero** when any check is `fail`. `idle` is distinct from `fail`: it names
a check that legitimately does not apply right now, not a genuine problem, so an idle-only report
never forces a non-zero exit. `lead-session` is `idle` (never `fail`) whenever no agent session is
currently open for the workspace (e.g. right after the `setup-monitors` skill's manual-test recipe
tears down its throwaway daemon and session, §"Verify It Fires"); its `detail` text names this
explicitly — "expected when no agent session is currently open" — and its remediation is still shown,
since opening a session is still a useful next step for a user who wants one.

`daemon-reachable` is more nuanced (issue #382 item 2): a down daemon is `idle` **only when no lead
session is registered for the workspace** — the same "nothing is actually open yet" state as above.
When a lead session IS registered but the daemon is unreachable, that combination means an agent
session is actively open with no daemon behind it — almost always a mid-session crash or a daemon
someone killed — so `daemon-reachable` is `fail` (non-zero exit) instead, and its `detail` names the
registered lead session rather than using the "expected when no agent session is currently open"
wording (which would be actively misleading in that case). Where the underlying connection error is
available, `detail` also distinguishes _why_ the daemon looks unreachable — a timeout ("daemon
present but not answering") reads differently from no daemon process at all, and a version-skewed
daemon that answered but rejected the request as unsupported (see "Transport and data source" above)
is called out by name rather than folded into either. Only the exit-code weight and status glyph
changed for the idle case (prior to issue #373, both checks were unconditionally classified `fail` and
forced a non-zero exit even when nothing was actually broken — issue #331 had fixed the wording but
not the exit code). A down daemon does not stop the rest of the diagnosis either way — the per-monitor
rollup is still produced (from the in-process fallback) and the line explicitly says the daemon is
down. Text and JSON summaries report a fourth `idle` count alongside `passed`/`failed`/`skipped`.

### Per-monitor rollup

For each monitor, `doctor` reports: **id**, **source type**, **urgency**, **cadence** (the cron
expression for `schedule` sources, else the observe interval), **last-observed** time (or `never`),
**next-due** time, **last-event** time (or `none`), and the **unread / claimed / acknowledged**
delivery-state counts for the workspace's lead session — or an explicit `never observed` marker (the
monitor has no observation history) / `lead-session=none` marker (the workspace has no lead session).
The three delivery states are distinct (000 AP): claiming a delivery never acknowledges it.

### Output

**Text format:** a workspace/monitors/daemon header, one line per check (with an indented `↳`
remediation on failures), and a closing `Summary: <n> passed, <n> failed, <n> skipped.` line.

**JSON format (`--format json`):** a stable machine-readable shape. Dates are ISO-8601 strings or
`null`; `ok` is `true` iff no check failed.

```json
{
  "ok": false,
  "generatedAt": "<iso8601>",
  "workspace": "<path>",
  "monitorsDir": "<path>",
  "daemon": { "running": false, "socketPath": "<path>" },
  "leadSession": false,
  "checks": [
    {
      "name": "project-enabled",
      "status": "pass|fail|skip|idle",
      "detail": "<string>",
      "remediation": "<string | null>"
    }
  ],
  "monitors": [
    {
      "id": "<string>",
      "sourceType": "<string>",
      "urgency": "low|normal|high",
      "valid": true,
      "validationError": "<string | null>",
      "lastObservedAt": "<iso8601 | null>",
      "neverObserved": false,
      "nextDueAt": "<iso8601 | null>",
      "cadence": "<string>",
      "lastEventAt": "<iso8601 | null>",
      "delivery": { "unread": 0, "claimed": 0, "acknowledged": 0 }
    }
  ],
  "summary": { "passed": 0, "failed": 0, "skipped": 0, "idle": 0 }
}
```

`checks[]` always appears in the fixed order above (`project-enabled`, `monitors-directory`,
`monitors-valid`, `daemon-reachable`, `lead-session`, then one `monitor:<id>` per discovered
monitor). When `leadSession` is `false`, each monitor's `delivery` counts are all `0` and represent
"no lead session". Errors (e.g. an unreadable store) use the standard `reportError()` shape
(`{ "error": "..." }` to stdout in JSON mode, `Error: …` to stderr otherwise) and exit 1.

---

## §16 `verify` — Prove a monitor delivers end-to-end

**Source:** `apps/cli/src/commands/verify.ts` (+ `verify-budget.ts`, `verify-report.ts`)
**Status:** Fully implemented (spawns and supervises an isolated daemon; falls back to the workspace daemon under a flag).

### Purpose

Answers "does this monitor actually deliver, right now?" in **one command**. It replaces the manual
Phase-5 "prove it" recipe (a custom `--socket`, a scratch `AGENTMONITORS_DB`, a backgrounded daemon
with `trap` cleanup, hand-built hook JSON payloads, two poll loops with two different budgets, and
two session-id concepts) — the single most concentrated DX liability across four usability studies
(issue #399). `verify` runs that whole recipe internally and prints one clean **PASS** (with the
delivered `additionalContext` as a proof artifact) or **FAIL** (naming the stage that failed). This
command is the canonical way to run that proof; the getting-started "Prove it, right now" walkthrough
(`apps/website/src/pages/docs/getting-started.md`) documents the same pipeline as a manual,
host-agnostic socket-level fallback that mirrors what `verify` automates.

**Verb/placement.** `verify` is a **top-level** command, a sibling of `doctor` — not a `monitor`
subcommand. `monitor test`/`history`/`explain` are read-only inspectors that never mutate state or
boot a daemon; `verify` is an **active, stateful end-to-end proof** that boots a daemon, registers a
session, triggers a real change, and confirms delivery. Modeling it as a `monitor` inspector would
wrongly attract future read-only-inspector behavior; its true kin is the workspace-level `doctor`.

### Usage

```
agentmonitors verify [monitor] [--dir <path>] [--workspace <path>] [--manual]
                      [--use-workspace-daemon] [--timeout-ms <ms>] [--format <text|json>]
```

| Flag                     | Default                        | Description                                                                                                                                                                           |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[monitor]`              | the sole monitor, if exactly 1 | Monitor id to verify. Omitting it with 0 or >1 monitors is a setup error naming the choices.                                                                                          |
| `--dir <path>`           | `<workspace>/.claude/monitors` | Directory containing monitor definitions.                                                                                                                                             |
| `--workspace <path>`     | current working dir            | Workspace path; resolved to an absolute path (same as `doctor`).                                                                                                                      |
| `--manual`               | off (auto-trigger)             | Skip the auto-trigger; prompt the operator to make the change and watch for it (for sources `verify` can't fabricate a change for).                                                   |
| `--use-workspace-daemon` | off (isolated)                 | Run against the workspace's real daemon/db (booting a detached one if needed) and **leave it running**, so a follow-up `doctor` reflects the delivery. Requires an enabled workspace. |
| `--timeout-ms <ms>`      | derived (see Budget)           | Override the **post-trigger** detection budget, in milliseconds (matches the `--poll-ms` / `--reap-after-ms` unit-suffixed convention).                                               |
| `--format <format>`      | `text`                         | Output format: `text`, `json`.                                                                                                                                                        |

### What it does

1. **Resolve** the monitor and confirm its `watch.type` source is registered.
2. **Boot a daemon.** By default an **isolated** daemon on a temp socket + db, spawned as a
   _supervised child_ (piped stderr, reaping disabled) so `verify` can both fully tear it down and
   observe a crash with the daemon's own error (issue #398). `--use-workspace-daemon` reuses (or
   detaches-boots) the workspace daemon instead and never tears it down.
3. **Register** a throwaway lead session (closed on exit).
4. **Baseline.** Wait for the monitor's first observation to land (no event on the first tick).
5. **Trigger.** For file-fingerprint, auto-trigger by creating a **scratch file** that _attempts_ to
   match the first pattern glob — reusing its static directory prefix (segments before the first
   glob-magic segment) and its extension — or, for a literal single-file glob, a brief,
   restored-on-exit edit of the watched file itself. This best-effort placement cannot fabricate a
   match for every pattern: a glob whose **filename segment itself is a wildcard** (`file-?.md`,
   `data-[0-9].json`) or whose only variability is a **wildcard directory with a literal filename**
   has no derivable sibling the scratch file would match, so the trigger produces no observable
   change and `verify` fails fast (`no-change` / `no-files-matched`) pointing at `--manual`. `--manual`
   (and any source `verify` can't fabricate a change for) prints a "make your change now" prompt and
   watches instead. The scratch file / edit is reverted on exit **and** on SIGINT/SIGTERM.
6. **Observe.** Poll observation history for a **post-trigger** outcome. A `triggered` row is
   success. A `no-files-matched` row (glob matched zero files) is always a **fail-fast**. A
   `no-change` row normally means the trigger did nothing (**fail fast**, point at `--manual`) —
   **except** while a `debounce`/`throttle` notify window is settling: there the change was observed
   but is being held, recorded as a `suppressed` row, and the emitting `triggered` row only appears at
   flush. So a `suppressed` row is not a distinct `verify` verdict; it is treated as "settling" and
   keeps the wait alive, suppressing the `no-change` fail-fast until the flush (or the budget) — the
   post-trigger history is `[suppressed, no-change…, triggered]` (issue #399 criterion 4).
7. **Materialize.** Confirm an unread event exists for the session.
8. **Deliver.** Claim via the **real `hook deliver` path** — for `high` urgency at
   `turn-interruptible` (previewing settled high events and packing them under the 4000-char cap
   exactly as `hook deliver` does), otherwise the `post-compact` recap — and render the same
   `additionalContext` a hook would inject.

If the daemon exits at any point, `verify` fails fast with a **`daemon-died`** verdict and prints the
daemon's captured output — never an ambiguous empty result.

### Budget (interval-aware)

The poll budget is derived from the monitor's **own** declared timing (issue #399 criterion 2), not
a fixed 40s: `interval` (an explicit `watch.interval`, else the source default — file-fingerprint
30s, api-poll 300s, schedule's 60s tick) plus the notify **settle** (`debounce`'s `settle-for`; 0
for `throttle`; and, for `high` urgency with **no** explicit `notify` block, the runtime's default
15s debounce settle — 002 §9, issue #406) plus, for `high` urgency, the **15s claim-settle** window
(002 §9.1), plus a margin of `max(5s, 25% of interval)`. Two phases are budgeted separately —
**baseline** (`interval + margin`) and **detect** (`interval + settle + high-claim-settle +
margin`). Elapsed/ETA progress is printed to **stderr** so the operator is never left staring at
empty output; `--timeout-ms` overrides the detect-phase budget. (These interval/settle defaults are
sourced from the runtime's canonical `schedulingDefaults` export in `@agentmonitors/core` — the same
values the daemon schedules against, not a hand-mirrored copy — and the settle resolution itself
calls the same `defaultNotifyConfigForUrgency` function the runtime tick uses, so the budget estimate
cannot drift from real scheduling or notify defaults.)

### Output

**Text (default):** a per-stage checklist (`daemon`, `session`, `baseline`, `trigger`, `observe`,
`materialize`, `deliver`), then a `PASS` line echoing the delivered `additionalContext`, or a `FAIL`
line naming the failing stage (and, for `daemon-died`, the daemon's own output). Progress lines go to
stderr; the report goes to stdout.

**JSON (`--format json`):** a stable machine shape.

```json
{
  "ok": true,
  "monitorId": "docs-watch",
  "stages": [
    {
      "name": "deliver",
      "status": "pass|fail|pending|skip",
      "detail": "<string>"
    }
  ],
  "failure": {
    "kind": "no-change|no-files-matched|budget-exceeded|daemon-died|delivery-empty|setup",
    "message": "<string>"
  },
  "additionalContext": "<string | null>",
  "daemonStderr": "<string | null>",
  "elapsedMs": 3200
}
```

`failure` is `null` on success; `additionalContext` is the delivered proof on success and `null` on
failure.

### Exit codes

`0` on **PASS**; `1` on any genuine **FAIL** (`no-change`, `no-files-matched`, `budget-exceeded`,
`daemon-died`, `delivery-empty`) or setup error (monitor not found/ambiguous, unknown source, boot
failure). A non-zero exit therefore always means the setup does **not** currently deliver.

### Non-goals

`verify` does not change runtime notify/debounce timing, and does not remove the manual recipe (kept
as a debug/host-agnostic appendix in the getting-started docs). It is not a substitute for `doctor`'s
static health checks — it proves the _dynamic_ delivery path the checks can't exercise.

---

## §17 Exit codes & diagnostics

### General conventions

| Condition                           | Exit code                        | Output target                                       |
| ----------------------------------- | -------------------------------- | --------------------------------------------------- |
| Success                             | `0`                              | —                                                   |
| Validation/argument error           | `1` (via `process.exitCode = 1`) | stderr (text) or stdout (JSON `{ "error": "..." }`) |
| Daemon socket unavailable / timeout | `1`                              | stderr                                              |
| Unknown source / parse failure      | `1`                              | stderr or JSON error                                |
| Placeholder command invoked         | `1`                              | stderr                                              |

### Error output routing

All commands that support `--format json` use `reportError()` (`apps/cli/src/output.ts`) for errors:

- **JSON mode:** writes `{ "error": "<message>" }` to **stdout** (so JSON consumers get a consistent channel) and sets `process.exitCode = 1`.
- **Text mode:** writes `Error: <message>` to **stderr** and sets `process.exitCode = 1`.

### Commands that use `process.exitCode` (not `process.exit`)

All commands set `process.exitCode = 1` rather than calling `process.exit(1)`. This allows in-flight async operations and Node.js cleanup handlers to complete before the process terminates.

### Daemon socket timeout

`callDaemon()` defaults to a **2 000 ms timeout**. The `daemonAvailable()` ping uses a **500 ms timeout**. On timeout, the error message is: `Timed out waiting for AgentMon daemon at <socketPath>`.

### Commands with no error handling on `--format json`

`inbox ack/start/complete/fail/archive` and `events ack` do not accept `--format json`; their errors always go to stderr.

---

## Appendix A — Command inventory

| Command    | Subcommand | Transport                                                     | Status                                                            |
| ---------- | ---------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `init`     | —          | in-process                                                    | Fully implemented (bootstrap + scaffold)                          |
| `validate` | —          | in-process                                                    | Fully implemented (full schema)                                   |
| `scan`     | —          | in-process                                                    | Fully implemented                                                 |
| `inbox`    | `list`     | in-process                                                    | Fully implemented                                                 |
| `inbox`    | `ack`      | in-process                                                    | Fully implemented                                                 |
| `inbox`    | `start`    | in-process                                                    | Fully implemented                                                 |
| `inbox`    | `complete` | in-process                                                    | Fully implemented                                                 |
| `inbox`    | `fail`     | in-process                                                    | Fully implemented                                                 |
| `inbox`    | `archive`  | in-process                                                    | Fully implemented                                                 |
| `monitor`  | `test`     | in-process                                                    | Fully implemented                                                 |
| `monitor`  | `history`  | socket (with in-process fallback)                             | Fully implemented                                                 |
| `monitor`  | `explain`  | socket (with in-process fallback)                             | Fully implemented                                                 |
| `source`   | `list`     | in-process                                                    | Fully implemented                                                 |
| `source`   | `search`   | —                                                             | Placeholder / not implemented (NP3)                               |
| `source`   | `install`  | —                                                             | Placeholder / not implemented (NP3)                               |
| `source`   | `update`   | —                                                             | Placeholder / not implemented (NP3)                               |
| `source`   | `remove`   | —                                                             | Placeholder / not implemented (NP3)                               |
| `schema`   | `generate` | in-process                                                    | Fully implemented                                                 |
| `daemon`   | `once`     | in-process                                                    | Fully implemented                                                 |
| `daemon`   | `run`      | creates socket server                                         | Fully implemented (`--reap-after-ms` added)                       |
| `daemon`   | `status`   | socket (with in-process fallback)                             | Fully implemented                                                 |
| `daemon`   | `stop`     | socket                                                        | Fully implemented                                                 |
| `doctor`   | —          | socket (with in-process fallback)                             | Fully implemented                                                 |
| `verify`   | —          | supervised isolated daemon (or workspace daemon under a flag) | Fully implemented (§16)                                           |
| `session`  | `open`     | socket                                                        | Fully implemented                                                 |
| `session`  | `close`    | socket                                                        | Fully implemented                                                 |
| `session`  | `list`     | socket                                                        | Fully implemented                                                 |
| `session`  | `start`    | in-process + socket (lazy boot)                               | Fully implemented                                                 |
| `session`  | `end`      | socket                                                        | Fully implemented                                                 |
| `events`   | `list`     | socket                                                        | Fully implemented                                                 |
| `events`   | `ack`      | socket                                                        | Fully implemented                                                 |
| `hook`     | `claim`    | socket                                                        | Fully implemented                                                 |
| `hook`     | `deliver`  | socket (always exits 0)                                       | Fully implemented                                                 |
| `channel`  | `serve`    | stdio MCP server + socket                                     | Two-way (push + `agentmon_ack`)                                   |
| `snapshot` | —          | daemon (read-only)                                            | **Target** (§14.1, [007 §3.1](./007-agent-facing-interaction.md)) |
| `diff`     | —          | daemon (read-only)                                            | **Target** (§14.2, [007 §3.2](./007-agent-facing-interaction.md)) |
| `summary`  | —          | daemon (read-only)                                            | **Target** (§14.3, [007 §3.3](./007-agent-facing-interaction.md)) |
| `watch`    | (declare)  | daemon (declaration-only)                                     | **Target** (§14.4, [007 §4](./007-agent-facing-interaction.md))   |
| `watch`    | `list`     | daemon (read-only)                                            | **Target** (§14.4, [007 §4](./007-agent-facing-interaction.md))   |
| `watch`    | `cancel`   | daemon                                                        | **Target** (§14.4, [007 §4.4](./007-agent-facing-interaction.md)) |
| `inspect`  | —          | daemon (read-only)                                            | **Target** (§14.5, [007 §5](./007-agent-facing-interaction.md))   |
