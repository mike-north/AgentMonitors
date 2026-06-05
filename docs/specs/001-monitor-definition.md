# 001 — Monitor Definition & Authoring

> **Status:** Draft
> **Depends on:** [000-principles.md](./000-principles.md)
> **Covers:** `MONITOR.md` structure, frontmatter schema, identity, scoping notes, notify semantics, authoring examples

## 1. Overview

This document specifies the authored monitor definition: where it lives, how it is parsed, what frontmatter fields mean, and which authoring constraints are part of the implementation contract.

### Why a dedicated monitor-definition spec?

The rest of the system depends on monitor definitions being stable. Runtime scheduling, source execution, hook delivery, schema generation, and validation all derive from authored monitor data. A monitor file is therefore not just a configuration convenience; it is the root object for the delivery pipeline (PP2, SP1, AP6).

### Principles Satisfied

| Section                  | Principles    |
| ------------------------ | ------------- |
| File layout and identity | PP2, SP1, SP2 |
| Frontmatter schema       | PP2, PP5, AP4 |
| Notify semantics         | PP5, PP7      |
| Scope notes              | AP5           |

## 2. Monitor File Layout

A monitor **MUST** live at one of the following two forms:

```text
<monitors-root>/<monitor-id>/MONITOR.md   (folder monitor — id = parent directory name)
<monitors-root>/<monitor-id>.md           (flat monitor — id = filename without extension)
```

Where:

- `<monitors-root>` is the directory being scanned or validated
- `<monitor-id>` is derived from the file path as described below

The parser **MUST** derive the monitor's stable machine ID using form-aware logic (SP1):

- **Folder monitor** (`<id>/MONITOR.md`): the id is the basename of the parent directory.
- **Flat monitor** (`<id>.md` directly in the monitors root): the id is the filename without its
  extension.

> Verified: `libs/core/src/parser/parse-monitor.ts` — `const base = path.basename(filePath)`, then
> `base === 'MONITOR.md' ? path.basename(path.dirname(filePath)) : path.parse(filePath).name`. A
> derived id that is empty or begins with `.` is rejected as a parse error.

The file **MUST** contain:

- YAML frontmatter
- a Markdown body, which may be empty

The parser **MUST**:

- validate frontmatter against the monitor schema
- trim outer leading/trailing whitespace from the Markdown body before storing it as monitor instructions (stored in the `instructions` field on `MonitorDefinition`)
- preserve the absolute source file path

> Verified: `libs/core/src/parser/parse-monitor.ts` — trimming at line 49 (`parsed.content.trim()`); `filePath` stored at line 51; schema validation via `monitorFrontmatterSchema.safeParse` at line 36.

The scanner discovers monitors using two glob passes relative to the supplied base directory:

1. **Folder monitors**: `**/MONITOR.md`, then excluding any match at depth-0 — a folder monitor is
   `<id>/MONITOR.md` (at least one directory deep, the folder name being the id). A bare
   `<monitors-root>/MONITOR.md` is **not** a valid monitor and is ignored.
2. **Flat monitors**: `*.md` at depth-1 only, excluding any file named `MONITOR.md` — resolves to
   flat-form monitors. Markdown assets nested inside a folder monitor's directory are intentionally
   **not** treated as monitors.

All discovered paths are resolved to absolute paths before parsing.

> Verified: `libs/core/src/parser/scan-monitors.ts` — `globSync('**/MONITOR.md', ...)` filtered to
> exclude matches whose directory is the monitors root (depth-0), and
> `globSync('*.md', ...).filter(f => basename(f) !== 'MONITOR.md')` for flat monitors.

## 3. Monitor Frontmatter Schema

Each monitor frontmatter object **MUST** contain:

| Field        | Type     | Required | Meaning                                                                                           |
| ------------ | -------- | -------- | ------------------------------------------------------------------------------------------------- |
| `name`       | string   | no       | Human-readable display name; defaults to the monitor id (filename or directory name) when omitted |
| `source`     | string   | yes      | Source plugin name, kebab-case                                                                    |
| `urgency`    | enum     | yes      | `low`, `normal`, or `high`                                                                        |
| `event-kind` | enum     | yes      | `mutation`, `notification`, or `alert`                                                            |
| `scope`      | object   | yes      | Source-specific configuration                                                                     |
| `notify`     | object   | no       | Explicit debounce/throttle policy                                                                 |
| `tags`       | string[] | no       | Tags for later filtering                                                                          |

> Verified: `libs/core/src/schema/monitor-schema.ts` lines 30–41 — all fields above match the `monitorFrontmatterSchema` Zod object definition.

### 3.1 `source`

The `source` field identifies the observation source plugin. It **MUST** match the pattern `/^[a-z][a-z0-9-]*$/`: it must start with a lowercase letter, and subsequent characters may be lowercase letters, digits, or hyphens. The source name is the key used to resolve the plugin in the source registry, select the correct `scope` schema, and determine runtime behavior for due scheduling defaults in some cases.

> Verified: `libs/core/src/schema/monitor-schema.ts` lines 33–35 — `z.string().min(1).regex(/^[a-z][a-z0-9-]*$/, 'Source must be kebab-case')`.

> **Note on drift:** The draft described `source` as "kebab-case" without further qualification. The actual regex `/^[a-z][a-z0-9-]*$/` is slightly more restrictive: the first character must be a lowercase ASCII letter (not a digit or hyphen). This spec uses the code as the authoritative definition.

### 3.2 `urgency`

The `urgency` field **MUST** accept exactly: `low`, `normal`, `high`. Even though earlier public docs emphasized only `normal` and `high`, the implemented schema, runtime, and CLI all support `low` (PP5).

> Verified: `libs/core/src/schema/monitor-schema.ts` line 36 — `z.enum(['low', 'normal', 'high'])`. Also confirmed in `libs/core/src/schema/types.ts` line 14 — `export type Urgency = 'low' | 'normal' | 'high'`.

### 3.3 `event-kind`

The `event-kind` field **MUST** accept exactly: `mutation`, `notification`, `alert`. The event kind describes the semantic nature of the signal; it does not itself change runtime scheduling or hook timing.

> Verified: `libs/core/src/schema/monitor-schema.ts` line 37 — `z.enum(['mutation', 'notification', 'alert'])`. Also confirmed in `libs/core/src/schema/types.ts` line 15 — `export type EventKind = 'mutation' | 'notification' | 'alert'`.

### 3.4 `scope`

The `scope` field **MUST** be a plain object with string keys. The value types of individual keys are unconstrained at the core schema level and are delegated to source-specific validation.

> Verified: `libs/core/src/schema/monitor-schema.ts` line 38 — `scope: z.record(z.string(), z.unknown())`.

### 3.5 `notify`

If present, `notify` **MUST** be one of these shapes:

```yaml
notify:
  strategy: debounce
  settle-for: 5m
```

```yaml
notify:
  strategy: throttle
  suppress-for: 30m
```

Duration strings **MUST** match `^\d+[smhd]$` (one or more digits followed by exactly one of `s`, `m`, `h`, `d`). Examples: `30s`, `5m`, `1h`, `2d`.

If `notify` is omitted, default delivery behavior is defined in [002-runtime-delivery.md](./002-runtime-delivery.md).

> Verified: `libs/core/src/schema/monitor-schema.ts` — `debounceNotifySchema` at lines 5–13 (requires `strategy: 'debounce'` and `settle-for` matching `durationPattern`); `throttleNotifySchema` at lines 15–23 (requires `strategy: 'throttle'` and `suppress-for` matching `durationPattern`); `durationPattern` at line 3 is `/^\d+[smhd]$/`; `notifySchema` is a discriminated union on `strategy` at lines 25–28.

### 3.6 `tags`

If present, `tags` **MUST** be an array of strings. Tags have no runtime semantics in the current implementation and are intended for future filtering.

> Verified: `libs/core/src/schema/monitor-schema.ts` line 40 — `tags: z.array(z.string()).optional()`.

## 4. Monitor Identity and Uniqueness

Monitor IDs **MUST** be unique within a scanned monitor tree (SP2). The runtime stores monitor state by `monitorId`, so two monitors deriving the same ID would alias each other's persisted source and notify state — a durable-state correctness hazard, not a cosmetic one.

This is enforced (current behavior): `scanMonitors` reports folder-name collisions in `ScanResult.duplicateIds` (a `DuplicateMonitorId[]` of `{ id, filePaths }`). The runtime tick **MUST** refuse to run when any duplicate is present, and `agentmonitors validate` **MUST** fail (non-zero exit) while `scan` reports the collisions.

> Verified: `libs/core/src/parser/scan-monitors.ts` — the scan groups parsed monitors by `id` and populates `duplicateIds`; `libs/core/src/runtime/service.ts` `tick()` throws when `duplicateIds` is non-empty; `apps/cli/src/commands/validate.ts` adds duplicates to its error set and exits non-zero.

Integrators **MUST NOT** create two monitor directories with the same basename under the same monitored tree; doing so is now a hard error rather than a silent hazard.

## 5. Monitor Body Semantics

The Markdown body after the frontmatter is the monitor's handling instructions. The body is author-written guidance intended for the receiving agent. When a source observation omits its own `body`, the runtime uses these instructions as the default event body. This makes the monitor body part of the delivery contract, not mere documentation.

The stored value is the trimmed body — leading and trailing whitespace are removed. An empty body is permitted (results in an empty string after trimming).

> Verified: `libs/core/src/parser/parse-monitor.ts` line 49 — `instructions: parsed.content.trim()`; `libs/core/src/schema/types.ts` line 9 — `instructions: string` (no minimum length constraint, so empty string is valid).

## 6. Scope and Activation Notes

The public docs describe monitor roots at enterprise, user, and project scope. Those concepts remain useful, but the current implementation does **not** define a merge algorithm across multiple roots (AP5). What the implementation currently defines is simpler:

- commands and runtime ticks operate on one supplied monitors directory at a time
- the directory may represent project-level, user-level, or other deployment conventions chosen by the integrator

This means scope precedence, override order, and multi-root composition are outside the current contract.

## 7. Authoring Examples

### 7.1 File mutation monitor

```md
---
name: Build Config Drift
source: file-fingerprint
urgency: high
event-kind: mutation
scope:
  globs:
    - 'package.json'
    - 'tsconfig.json'
notify:
  strategy: debounce
  settle-for: 30s
tags: [build, config]
---

When these files change, determine whether build behavior, dependency state, or developer setup instructions need to be updated.
```

**What this example proves:**

- monitor ID is folder-derived rather than declared in frontmatter
- `high` urgency is valid and can still be combined with explicit notify timing
- `settle-for: 30s` is a valid duration string matching `^\d+[smhd]$`
- the Markdown body is intended to become the fallback event body

### 7.2 Low-urgency schedule monitor

```md
---
name: Weekly Maintenance Reminder
source: schedule
urgency: low
event-kind: notification
scope:
  cron: '0 9 * * 1'
  timezone: America/Los_Angeles
  label: Weekly maintenance review
tags: [maintenance]
---

Review stale monitors, old failed items, and event volume trends.
```

**What this example proves:**

- `low` urgency is a valid authoring value
- the schedule source uses source-specific `scope` fields (`cron`, `timezone`, `label`) that are not constrained by the core schema
- human-readable labels belong in source-specific scope where appropriate

## 8. Validation Implications

At minimum, monitor authoring validation should be able to prove:

- the frontmatter parses successfully
- required top-level fields are present
- `urgency`, `event-kind`, and `notify.strategy` values are in-range
- duration strings are syntactically valid
- the selected source exists in the source registry
- required source-specific scope fields are present

The `agentmonitors validate` command enforces all of the above, including full per-source JSON Schema validation of `scope` against each source's `scopeSchema` (via the exported core helper `validateScope`). See [004-validation-testing.md](./004-validation-testing.md) §2.2.
