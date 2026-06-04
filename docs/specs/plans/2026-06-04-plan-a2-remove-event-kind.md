# Plan A2 — Remove `event-kind` (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely remove the `event-kind` / `eventKind` / `event_kind` concept from the codebase. It is required, behaviorally inert (stored + filterable, but no code branches on its value), and its enum mixes axes. Categorization is covered by `tags`, change-nature by `changeKind`, importance by `urgency`.

**Architecture:** Pure deletion, no migration (no users; local DBs are disposable). Delete in dependency order so the TypeScript compiler points at every downstream site: schema/types → DB → store/runtime/inbox → schema-generator → CLI → tests → docs. Commit per layer.

**Tech Stack:** TypeScript, Zod, drizzle-orm + better-sqlite3 (raw `CREATE TABLE` SQL), vitest.

**Design source:** [docs/specs/design/2026-06-04-drop-in-monitors-steel-thread.md](../design/2026-06-04-drop-in-monitors-steel-thread.md) §3.2 ("Removed: `event-kind`").

**Depends on:** A1 (touches the same schema + parser tests; land A1 first or rebase). If A1 has merged, also delete the `event-kind` lines from the fixtures A1 added.

---

## File Structure (grounded inventory)

| Layer                | Files                                                                                                                                                                                                                                    | Change                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Schema/types/exports | `libs/core/src/schema/monitor-schema.ts:37`, `libs/core/src/schema/types.ts:15`, `libs/core/src/index.ts:12`                                                                                                                             | Delete the Zod field, the `EventKind` type, the re-export                                                    |
| Schema generator     | `libs/core/src/observation/schema-generator.ts:28,33-35`                                                                                                                                                                                 | Drop `event-kind` from `required` + `properties`                                                             |
| DB                   | `libs/core/src/inbox/schema.ts:14,22,61`, `libs/core/src/inbox/db.ts:57,116`                                                                                                                                                             | Delete `eventKindValues`, the column on both tables, both raw SQL lines                                      |
| Store/runtime        | `libs/core/src/runtime/store.ts:72,273,324-325`, `libs/core/src/runtime/service.ts:792`, `libs/core/src/runtime/types.ts:60,97,110`                                                                                                      | Delete hydrate/insert/filter + the `processObservation` read + the 3 type fields                             |
| Inbox                | `libs/core/src/inbox/types.ts:10,24,34`, `libs/core/src/inbox/inbox-service.ts:24,93,217-218`                                                                                                                                            | Delete the 3 type fields + hydrate/insert/filter                                                             |
| CLI                  | `apps/cli/src/daemon-ipc.ts:20,48,67,198`, `apps/cli/src/commands/events.ts:44,65,79`, `inbox.ts:30,47,64-65,113`, `init.ts:13,27,44`, `scan.ts:25`                                                                                      | Delete the IPC schema field, the `--event-kind` options + display, the template lines, the scan output field |
| Tests                | `schema/monitor-schema.test.ts`, `parser/parse-monitor.test.ts`, `parser/scan-monitors.test.ts`, `runtime/service.test.ts`, `inbox/inbox-service.test.ts`, `hook-bridge/bridge.test.ts`, `apps/cli/src/commands/cli.integration.test.ts` | Remove `event-kind:`/`eventKind` from fixtures + delete dedicated event-kind tests                           |
| Docs                 | `docs/specs/001,002,003,004,005,006`, `spec-changelog.md`, `.changeset/*`                                                                                                                                                                | Remove event-kind references; changelog + changeset                                                          |

---

## Task 1: Delete the schema field, type, and public export

**Files:** `libs/core/src/schema/monitor-schema.ts:37`, `libs/core/src/schema/types.ts:15`, `libs/core/src/index.ts:12`, `libs/core/src/schema/monitor-schema.test.ts`

- [ ] **Step 1: Update the schema test first (delete event-kind cases, prove omission is OK)**

In `libs/core/src/schema/monitor-schema.test.ts`: delete the tests `accepts all event-kind values`, `rejects missing event-kind`, and `rejects invalid event-kind`. Remove `'event-kind': ...` from every shared fixture (e.g. `validMinimal`). Add:

```ts
it('parses a minimal monitor without event-kind', () => {
  const result = monitorFrontmatterSchema.safeParse({
    source: 'file-fingerprint',
    urgency: 'normal',
    scope: { globs: ['x'] },
  });
  expect(result.success).toBe(true);
});

it('ignores an event-kind field if present (no longer part of the schema)', () => {
  const result = monitorFrontmatterSchema.safeParse({
    source: 'file-fingerprint',
    urgency: 'normal',
    'event-kind': 'mutation',
    scope: { globs: ['x'] },
  });
  // schema is non-strict, so an extra key is dropped, not an error
  expect(result.success).toBe(true);
  if (result.success) expect('event-kind' in result.data).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mike-north/core exec vitest run src/schema/monitor-schema.test.ts -t "without event-kind"`
Expected: FAIL — `event-kind` is still a required field, so omitting it currently fails. (Confirms the field is real before removing.)

- [ ] **Step 3: Delete the field, the type, and the export**

`libs/core/src/schema/monitor-schema.ts` — delete line 37 entirely:

```ts
  'event-kind': z.enum(['mutation', 'notification', 'alert']),
```

`libs/core/src/schema/types.ts` — delete line 15:

```ts
export type EventKind = 'mutation' | 'notification' | 'alert';
```

`libs/core/src/index.ts` — remove `EventKind` from the export list (line 12).

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `pnpm --filter @mike-north/core exec vitest run src/schema/monitor-schema.test.ts`
Expected: PASS. (Typecheck of the whole repo will still fail until later tasks — that's expected; this step only gates the schema tests.)

- [ ] **Step 5: Commit**

```bash
git add libs/core/src/schema/monitor-schema.ts libs/core/src/schema/types.ts libs/core/src/index.ts libs/core/src/schema/monitor-schema.test.ts
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Remove event-kind from the monitor frontmatter schema + public types"
```

---

## Task 2: Delete the schema-generator entries

**Files:** `libs/core/src/observation/schema-generator.ts:28,33-35`, its test if present.

- [ ] **Step 1: Update the generator test**

If `schema-generator.test.ts` asserts `event-kind` is in `required`/`properties`, change those assertions to assert it is **absent**:

```ts
expect(schema.required).not.toContain('event-kind');
expect(schema.properties).not.toHaveProperty('event-kind');
expect(schema.required).toEqual(['name', 'source', 'urgency', 'scope']);
```

> Note: after A1, `name` is optional — if the generator lists it in `required`, also drop `name` here and assert `required` is `['source', 'urgency', 'scope']`. Match the generator to the post-A1 schema.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @mike-north/core exec vitest run src/observation/schema-generator.test.ts`
Expected: FAIL — generator still emits `event-kind`.

- [ ] **Step 3: Delete the generator entries**

In `libs/core/src/observation/schema-generator.ts`: remove `'event-kind'` from the `required` array (line 28) and delete the `'event-kind': { type: 'string', enum: [...] }` property (lines 33-35).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @mike-north/core exec vitest run src/observation/schema-generator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/core/src/observation/schema-generator.ts libs/core/src/observation/schema-generator.test.ts
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Drop event-kind from the generated monitor JSON schema"
```

---

## Task 3: Delete the DB columns (drizzle + raw SQL)

**Files:** `libs/core/src/inbox/schema.ts:14,22,61`, `libs/core/src/inbox/db.ts:57,116`

- [ ] **Step 1: Delete the drizzle definitions**

`libs/core/src/inbox/schema.ts`: delete the `eventKindValues` const (line 14) and the `eventKind: text('event_kind', { enum: eventKindValues }).notNull()` column from **both** `inboxItems` (line 22) and `monitorEvents` (line 61).

- [ ] **Step 2: Delete the raw CREATE TABLE columns**

`libs/core/src/inbox/db.ts`: delete the `event_kind TEXT NOT NULL,` line in the `inbox_items` CREATE TABLE (line 57) and in the `monitor_events` CREATE TABLE (line 116).

- [ ] **Step 3: Typecheck (do not run yet — store/types still reference it)**

This task leaves the codebase non-compiling (store + service + types still reference `eventKind`). That is expected; Task 4 fixes the consumers. Do **not** commit until Task 4 compiles. Proceed directly to Task 4.

---

## Task 4: Delete store/runtime/inbox usages + the runtime test fixtures

**Files:** `libs/core/src/runtime/store.ts:72,273,324-325`, `libs/core/src/runtime/service.ts:792`, `libs/core/src/runtime/types.ts:60,97,110`, `libs/core/src/inbox/types.ts:10,24,34`, `libs/core/src/inbox/inbox-service.ts:24,93,217-218`, `libs/core/src/runtime/service.test.ts`, `libs/core/src/inbox/inbox-service.test.ts`, `libs/core/src/hook-bridge/bridge.test.ts`, `libs/core/src/parser/parse-monitor.test.ts`, `libs/core/src/parser/scan-monitors.test.ts`

- [ ] **Step 1: Delete the type fields**

`libs/core/src/runtime/types.ts`: delete `eventKind: EventKind;` from `MonitorEventRecord` (line 60) and `eventKind?: EventKind;` from `EventQuery` (line 110) and `SessionEventFilter` (line 97). Remove any now-unused `EventKind` import.

`libs/core/src/inbox/types.ts`: delete the `eventKind` field from `InboxItem` (line 10), `EnqueuePayload` (line 24), and `InboxFilter` (line 34).

- [ ] **Step 2: Delete the store/service/inbox-service usages**

`libs/core/src/runtime/store.ts`: delete `eventKind: row.eventKind,` (hydrate, line 72), `eventKind: input.eventKind,` (insert, line 273), and the `if (query.eventKind) conditions.push(eq(monitorEvents.eventKind, query.eventKind));` filter (lines 324-325).

`libs/core/src/runtime/service.ts`: delete `eventKind: input.monitor.frontmatter['event-kind'],` from the `processObservation`/`insertEvent` call (line 792).

`libs/core/src/inbox/inbox-service.ts`: delete `eventKind: row.eventKind,` (line 24), `eventKind: payload.eventKind,` (line 93), and the `if (filter?.eventKind) ...` filter (lines 217-218).

- [ ] **Step 3: Fix the test fixtures**

Apply this pattern to every test fixture: **remove `event-kind: mutation` (YAML frontmatter) and `eventKind: '...'` (object literals)**, and delete tests dedicated to event-kind:

- `runtime/service.test.ts` — remove the `event-kind: mutation` lines from the inline MONITOR.md fixtures (the `createMonitorFile` template and the debounce-flush fixture), and remove every `eventKind: '...'` from the `store.insertEvent({...})` calls.
- `inbox/inbox-service.test.ts` — remove `eventKind:` from fixtures; delete the `filters by eventKind` test.
- `hook-bridge/bridge.test.ts` — remove `eventKind:` from the mock events.
- `parser/parse-monitor.test.ts`, `parser/scan-monitors.test.ts` — remove `event-kind:` from the YAML fixtures and any `frontmatter['event-kind']` assertions.

> If `createMonitorFile` in `service.test.ts` hard-codes `event-kind: mutation` in its template literal, remove that line from the template so every test using it stops emitting the field.

- [ ] **Step 4: Run the core suite + typecheck**

Run: `pnpm --filter @mike-north/core exec vitest run`
Expected: PASS.

Run: `pnpm --filter @mike-north/core exec tsc -p tsconfig.build.json --noEmit`
Expected: no errors (warnings about missing release tags are pre-existing and fine).

- [ ] **Step 5: Commit (Tasks 3 + 4 together — first compiling state)**

```bash
git add libs/core/src/inbox/schema.ts libs/core/src/inbox/db.ts libs/core/src/runtime libs/core/src/inbox
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Remove the event_kind column and all core read/write/filter usages"
```

---

## Task 5: Delete the CLI usages

**Files:** `apps/cli/src/daemon-ipc.ts:20,48,67,198`, `apps/cli/src/commands/events.ts:44,65,79`, `apps/cli/src/commands/inbox.ts:30,47,64-65,113`, `apps/cli/src/commands/init.ts:13,27,44`, `apps/cli/src/commands/scan.ts:25`, `apps/cli/src/commands/cli.integration.test.ts`

- [ ] **Step 1: daemon-ipc**

`apps/cli/src/daemon-ipc.ts`: delete `eventKindValues` (line 20), `eventKindSchema` (line 48), the `eventKind: eventKindSchema.optional(),` field in `eventsListParamsSchema` (line 67), and the `...(params.eventKind ? { eventKind: params.eventKind } : {}),` pass-through (line 198). Remove any now-unused `EventKind` import.

- [ ] **Step 2: events + inbox commands**

`apps/cli/src/commands/events.ts`: delete the `new Option('--event-kind <kind>', ...)` (line 44), the `eventKind?` options field (line 65), and the pass-through (line 79).

`apps/cli/src/commands/inbox.ts`: delete the `--event-kind` Option (line 30), the `eventKind?` options field (line 47), the `filter.eventKind = ...` assignment (lines 64-65), and the `` `...(${item.eventKind})` `` display segment (line 113). Remove the `EVENT_KINDS` constant if it becomes unused.

- [ ] **Step 3: init templates + scan output**

`apps/cli/src/commands/init.ts`: delete the `event-kind: <value>` line from all three template literals (lines 13, 27, 44).

`apps/cli/src/commands/scan.ts`: delete the `'event-kind': m.monitor.frontmatter['event-kind'],` output field (line 25).

- [ ] **Step 4: Fix the CLI integration test**

`apps/cli/src/commands/cli.integration.test.ts`: remove `event-kind: mutation` from every inline MONITOR.md fixture (lines ~291, 329, 352, 451, 600, 841) and delete the `expect(parsed.monitors[0]).toHaveProperty('event-kind')` assertion (line 377). If a `scan` JSON-shape assertion exists, assert the absence instead:

```ts
expect(parsed.monitors[0]).not.toHaveProperty('event-kind');
```

- [ ] **Step 5: Build + run CLI tests + full check**

Run: `pnpm build`
Expected: build succeeds.

Run: `pnpm --filter @mike-north/cli exec vitest run --exclude "**/*.docker.test.ts"`
Expected: PASS.

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Remove the --event-kind CLI options, init templates, and scan output field"
```

---

## Task 6: Docs, changelog, changeset

**Files:** `docs/specs/001-monitor-definition.md`, `002-runtime-delivery.md`, `003-source-plugins.md`, `004-validation-testing.md`, `005-cli-reference.md`, `006-agent-integration.md`, `docs/specs/spec-changelog.md`, `.changeset/remove-event-kind.md`

- [ ] **Step 1: Strip event-kind from the specs**

- `001` — delete the `event-kind` frontmatter-table row and its dedicated subsection; remove it from the example MONITOR.md blocks and the validation checklist line.
- `002` — remove `eventKind` from the required-event-fields list (§5) and the `event_kind` rows from **both** the `monitor_events` and `inbox_items` persistence tables.
- `003` — drop `event-kind` from the top-level required-fields list.
- `004` — remove the `event-kind constrained to [...]` contract line and the "rejects invalid event-kind" coverage line.
- `005` — delete the `--event-kind` rows (inbox + events) and remove `event-kind`/`eventKind` from the JSON-output and text-output examples.
- `006` — remove the `event_kind` rows from the delivery-summary/channel field tables.

- [ ] **Step 2: Spec-changelog entry**

Prepend under `## Usage` in `docs/specs/spec-changelog.md`:

```markdown
## 2026-06-04 — Removed `event-kind`

- Removed the `event-kind` frontmatter field and the `event_kind` column from both `monitor_events`
  and `inbox_items`, plus the `--event-kind` CLI filters, the generated-schema entry, and the
  exported `EventKind` type. It was behaviorally inert; `tags` (categorization), `changeKind`
  (change-nature), and `urgency` (importance) cover its uses. No migration (no users; local DBs are
  disposable). Minor `@mike-north/core` changeset.
```

- [ ] **Step 3: Changeset**

Create `.changeset/remove-event-kind.md`:

```markdown
---
'@mike-north/core': minor
---

Remove the `event-kind` frontmatter field, the `event_kind` persistence column (on both `monitor_events` and `inbox_items`), the `--event-kind` CLI filters, the generated-schema `event-kind` entry, and the exported `EventKind` type. It carried no behavior; categorization is covered by `tags`, change-nature by `changeKind`, and importance by `urgency`.
```

- [ ] **Step 4: Format, link-check, clean verification**

Run: `npx --no-install prettier --write "docs/specs/*.md" ".changeset/*.md"`
Run: `/clean_blt`
Expected: clean build + lint + test all pass.

- [ ] **Step 5: Commit**

```bash
git add docs/specs .changeset/remove-event-kind.md
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Document the removal of event-kind"
```

---

## Final verification

- [ ] `grep -rn "event.kind\|eventKind" libs/core/src apps/cli/src` returns **nothing** (excluding dist/node_modules).
- [ ] `node apps/cli/dist/index.cjs init demo --source file-fingerprint` produces a MONITOR.md with **no** `event-kind` line, and `validate` accepts it.
- [ ] `/clean_blt` green.

## Self-review notes (author)

- **Spec coverage:** design §3.2 removal → Tasks 1–6; every grounded site from the inventory has a task.
- **Type consistency:** `EventKind` fully removed; no field named `eventKind` remains in any exported interface (`MonitorEventRecord`, `EventQuery`, `SessionEventFilter`, `InboxItem`, `EnqueuePayload`, `InboxFilter`).
- **Ordering:** schema/types first (compiler surfaces consumers) → DB → consumers (first compiling commit at Task 4) → CLI → docs. Task 3 deliberately leaves a non-compiling intermediate, committed together with Task 4.
