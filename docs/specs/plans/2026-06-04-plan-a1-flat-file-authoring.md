# Plan A1 — Flat-file authoring + optional `name` (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a monitor be authored as a flat `.claude/monitors/<name>.md` file (not only `<name>/MONITOR.md`), derive its id from the filename, and make frontmatter `name` optional (defaulting to the id).

**Architecture:** Pure `@agentmonitors/core` change in the parser/scanner + a one-line schema relaxation, plus updating the five display sites that read `frontmatter.name` to fall back to the monitor id. No runtime, daemon, DB, or delivery changes. No migration (the product has no users yet).

**Tech Stack:** TypeScript, Zod, `glob`, `gray-matter`, vitest. Single-test command: `pnpm --filter @agentmonitors/core exec vitest run <file>`.

**Design source:** [docs/specs/design/2026-06-04-drop-in-monitors-steel-thread.md](../design/2026-06-04-drop-in-monitors-steel-thread.md) §3.1 (flat file, promote to folder) and §3.2 (`name` optional).

**Out of scope (sibling plans):** removing `event-kind` (its own plan — now pure deletion, no migration); the lazy daemon, the `aipm` activation plugin, and the delivery hook.

---

## File Structure

| File                                          | Responsibility                                          | Change                                                          |
| --------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| `libs/core/src/parser/parse-monitor.ts`       | Derive monitor id + frontmatter from one file's content | Modify: id derivation handles flat vs folder form               |
| `libs/core/src/parser/scan-monitors.ts`       | Discover monitor files under a base dir                 | Modify: glob matches flat `*.md` **and** folder `**/MONITOR.md` |
| `libs/core/src/schema/monitor-schema.ts`      | Frontmatter Zod schema + types                          | Modify: `name` becomes optional                                 |
| `apps/cli/src/commands/scan.ts`               | `scan` command output                                   | Modify: display name falls back to id                           |
| `apps/cli/src/commands/validate.ts`           | `validate` command output                               | Modify: display name falls back to id                           |
| `apps/cli/src/commands/monitor-test.ts`       | `monitor test` output                                   | Modify: display name falls back to id                           |
| `libs/core/src/parser/parse-monitor.test.ts`  | Parser unit tests                                       | Add: flat-id + optional-name cases                              |
| `libs/core/src/parser/scan-monitors.test.ts`  | Scanner unit tests                                      | Add: flat + folder + collision cases                            |
| `libs/core/src/schema/monitor-schema.test.ts` | Schema unit tests                                       | Add: optional-name case                                         |
| `docs/specs/001-monitor-definition.md`        | Authoring spec                                          | Modify: identity + scanning + name-required rows                |
| `docs/specs/spec-changelog.md`                | Spec changelog                                          | Add: entry                                                      |
| `.changeset/*.md`                             | Release note                                            | Add: minor `@agentmonitors/core`                                |

---

## Task 1: Make `name` optional and fall back to the id at display sites

**Files:**

- Modify: `libs/core/src/schema/monitor-schema.ts:31`
- Modify: `apps/cli/src/commands/scan.ts:22`, `apps/cli/src/commands/scan.ts:57`
- Modify: `apps/cli/src/commands/validate.ts:73`, `apps/cli/src/commands/validate.ts:84`
- Modify: `apps/cli/src/commands/monitor-test.ts:166`
- Test: `libs/core/src/schema/monitor-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `libs/core/src/schema/monitor-schema.test.ts`:

```ts
it('accepts frontmatter that omits name (name is optional)', () => {
  const result = monitorFrontmatterSchema.safeParse({
    source: 'file-fingerprint',
    urgency: 'normal',
    'event-kind': 'mutation',
    scope: { globs: ['src/**/*.ts'] },
  });
  expect(result.success).toBe(true);
});

it('still rejects an empty-string name', () => {
  const result = monitorFrontmatterSchema.safeParse({
    name: '',
    source: 'file-fingerprint',
    urgency: 'normal',
    'event-kind': 'mutation',
    scope: { globs: ['x'] },
  });
  expect(result.success).toBe(false);
});
```

> Note: `event-kind` is still required in this plan — its removal is a separate plan. Keep it in fixtures here.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentmonitors/core exec vitest run src/schema/monitor-schema.test.ts -t "omits name"`
Expected: FAIL — the schema currently requires `name`, so `safeParse` returns `success: false`.

- [ ] **Step 3: Make `name` optional in the schema**

In `libs/core/src/schema/monitor-schema.ts`, change line 31 from:

```ts
  name: z.string().min(1, 'Monitor name is required'),
```

to:

```ts
  name: z.string().min(1, 'Monitor name must be non-empty when present').optional(),
```

- [ ] **Step 4: Fix the display sites that now see `string | undefined`**

`MonitorFrontmatter['name']` is now `string | undefined`, so the five readers must fall back to the monitor id.

`apps/cli/src/commands/scan.ts:22` — change `name: m.monitor.frontmatter.name,` to:

```ts
          name: m.monitor.frontmatter.name ?? m.monitor.id,
```

`apps/cli/src/commands/scan.ts:57` — change `frontmatter.name.padEnd(40),` to:

```ts
          (frontmatter.name ?? m.monitor.id).padEnd(40),
```

> If line 57's surrounding code does not have `m` in scope, use the id reference available there (the loop variable's `.monitor.id`); the value to pad is `<name-or-id>`.

`apps/cli/src/commands/validate.ts:73` — change `name: m.monitor.frontmatter.name,` to:

```ts
          name: m.monitor.frontmatter.name ?? m.monitor.id,
```

`apps/cli/src/commands/validate.ts:84` — change the log line to:

```ts
console.log(`  ${m.monitor.id}: ${m.monitor.frontmatter.name ?? m.monitor.id}`);
```

`apps/cli/src/commands/monitor-test.ts:166` — change `const monitorName = result.monitor.frontmatter.name;` to:

```ts
const monitorName = result.monitor.frontmatter.name ?? result.monitor.id;
```

- [ ] **Step 5: Run the schema test + typecheck to verify everything passes**

Run: `pnpm --filter @agentmonitors/core exec vitest run src/schema/monitor-schema.test.ts`
Expected: PASS (both new cases).

Run: `pnpm check`
Expected: PASS — no `string | undefined` errors remain at the display sites.

- [ ] **Step 6: Commit**

```bash
git add libs/core/src/schema/monitor-schema.ts libs/core/src/schema/monitor-schema.test.ts apps/cli/src/commands/scan.ts apps/cli/src/commands/validate.ts apps/cli/src/commands/monitor-test.ts
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Make monitor name optional; display sites fall back to id"
```

---

## Task 2: Derive the monitor id from the filename for flat files

**Files:**

- Modify: `libs/core/src/parser/parse-monitor.ts:27`
- Test: `libs/core/src/parser/parse-monitor.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `libs/core/src/parser/parse-monitor.test.ts`:

```ts
const FRONTMATTER = `---
source: file-fingerprint
urgency: normal
event-kind: mutation
scope:
  globs:
    - 'src/**/*.ts'
---
Body instructions.
`;

it('derives the id from the filename for a flat monitor file', () => {
  const outcome = parseMonitor(
    FRONTMATTER,
    '/repo/.claude/monitors/watch-src.md',
  );
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.monitor.id).toBe('watch-src');
});

it('derives the id from the parent directory for a folder monitor (MONITOR.md)', () => {
  const outcome = parseMonitor(
    FRONTMATTER,
    '/repo/.claude/monitors/pr-watch/MONITOR.md',
  );
  expect(outcome.ok).toBe(true);
  if (outcome.ok) expect(outcome.monitor.id).toBe('pr-watch');
});
```

- [ ] **Step 2: Run the test to verify the flat case fails**

Run: `pnpm --filter @agentmonitors/core exec vitest run src/parser/parse-monitor.test.ts -t "from the filename"`
Expected: FAIL — current code derives id from `path.dirname`, so a flat file at `.../monitors/watch-src.md` yields id `monitors`, not `watch-src`.

- [ ] **Step 3: Implement form-aware id derivation**

In `libs/core/src/parser/parse-monitor.ts`, replace line 27:

```ts
const dirName = path.basename(path.dirname(filePath));
```

with:

```ts
// A folder monitor is `<id>/MONITOR.md` (id = parent dir). A flat monitor is
// `<id>.md` directly in the monitors dir (id = filename without extension).
const base = path.basename(filePath);
const id =
  base === 'MONITOR.md'
    ? path.basename(path.dirname(filePath))
    : base.slice(0, -path.extname(base).length);
```

Then update the returned object (line ~47) to use `id` instead of `dirName`:

```ts
    monitor: {
      id,
      frontmatter: result.data,
      instructions: parsed.content.trim(),
      filePath,
    },
```

- [ ] **Step 4: Run the tests to verify both pass**

Run: `pnpm --filter @agentmonitors/core exec vitest run src/parser/parse-monitor.test.ts`
Expected: PASS (both new cases and the existing folder cases).

- [ ] **Step 5: Commit**

```bash
git add libs/core/src/parser/parse-monitor.ts libs/core/src/parser/parse-monitor.test.ts
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Derive monitor id from filename for flat monitor files"
```

---

## Task 3: Scan flat `*.md` files as well as folder `MONITOR.md`

**Files:**

- Modify: `libs/core/src/parser/scan-monitors.ts:38-39`
- Test: `libs/core/src/parser/scan-monitors.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `libs/core/src/parser/scan-monitors.test.ts` (uses a real temp dir, matching the repo's other fs tests):

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BODY = `---
source: file-fingerprint
urgency: normal
event-kind: mutation
scope:
  globs:
    - 'x'
---
Body.
`;

it('discovers both flat monitor files and folder MONITOR.md files', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-scan-'));
  try {
    // flat monitor
    writeFileSync(path.join(root, 'watch-src.md'), BODY, 'utf-8');
    // folder monitor + a markdown ASSET that must NOT be treated as a monitor
    mkdirSync(path.join(root, 'pr-watch'), { recursive: true });
    writeFileSync(path.join(root, 'pr-watch', 'MONITOR.md'), BODY, 'utf-8');
    writeFileSync(
      path.join(root, 'pr-watch', 'notes.md'),
      'just notes',
      'utf-8',
    );

    const result = await scanMonitors(root);
    const ids = result.monitors.map((m) => m.monitor.id).sort();

    expect(ids).toEqual(['pr-watch', 'watch-src']);
    expect(result.duplicateIds).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('flags a flat file and a folder that derive the same id as a duplicate', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agentmon-scan-'));
  try {
    writeFileSync(path.join(root, 'dup.md'), BODY, 'utf-8');
    mkdirSync(path.join(root, 'dup'), { recursive: true });
    writeFileSync(path.join(root, 'dup', 'MONITOR.md'), BODY, 'utf-8');

    const result = await scanMonitors(root);
    expect(result.duplicateIds.map((d) => d.id)).toEqual(['dup']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentmonitors/core exec vitest run src/parser/scan-monitors.test.ts -t "discovers both"`
Expected: FAIL — the current `**/MONITOR.md` pattern misses `watch-src.md`, so only `pr-watch` is discovered.

- [ ] **Step 3: Implement combined discovery**

In `libs/core/src/parser/scan-monitors.ts`, replace lines 38–39:

```ts
const pattern = '**/MONITOR.md';
const matches = globSync(pattern, { cwd: baseDir, absolute: true });
```

with:

```ts
// Folder monitors live at `<id>/MONITOR.md` (any depth). Flat monitors are
// `<id>.md` files directly in the monitors dir; markdown assets nested inside a
// folder monitor are intentionally NOT discovered (only depth-1 `*.md`, minus
// any stray MONITOR.md that the folder glob already covers).
const folderMatches = globSync('**/MONITOR.md', {
  cwd: baseDir,
  absolute: true,
});
const flatMatches = globSync('*.md', {
  cwd: baseDir,
  absolute: true,
}).filter((filePath) => path.basename(filePath) !== 'MONITOR.md');
const matches = [...folderMatches, ...flatMatches];
```

- [ ] **Step 4: Run the scanner tests to verify they pass**

Run: `pnpm --filter @agentmonitors/core exec vitest run src/parser/scan-monitors.test.ts`
Expected: PASS (new cases + existing folder/duplicate cases).

- [ ] **Step 5: Run the full core suite to catch regressions**

Run: `pnpm --filter @agentmonitors/core exec vitest run`
Expected: PASS (all suites).

- [ ] **Step 6: Commit**

```bash
git add libs/core/src/parser/scan-monitors.ts libs/core/src/parser/scan-monitors.test.ts
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Discover flat monitor files alongside folder MONITOR.md"
```

---

## Task 4: Sync the spec, changelog, and changeset

**Files:**

- Modify: `docs/specs/001-monitor-definition.md` (identity §, scanning §, frontmatter table `name` row)
- Modify: `docs/specs/spec-changelog.md`
- Create: `.changeset/flat-file-monitors.md`

- [ ] **Step 1: Update 001 — identity, scanning, and the `name` row**

In `docs/specs/001-monitor-definition.md`:

- In the file-location/identity section (around lines 29–39), document **both** forms: a flat `<monitors-root>/<id>.md` (id = filename without extension) and a folder `<monitors-root>/<id>/MONITOR.md` (id = parent directory). Update the "Verified" line to cite the new `parse-monitor.ts` id derivation.
- In the scanning section (around lines 54–56), state that the scanner discovers folder monitors via `**/MONITOR.md` **and** flat monitors via depth-1 `*.md` (excluding `MONITOR.md`), and that markdown assets nested inside a folder monitor are not treated as monitors. Update the "Verified" line to cite the new `scan-monitors.ts`.
- In the frontmatter table (line 64), change the `name` row's "Required?" from `yes` to `no`, and add to its description: "defaults to the monitor id (filename or directory name) when omitted."

- [ ] **Step 2: Add a spec-changelog entry**

Prepend under the `## Usage` block in `docs/specs/spec-changelog.md`:

```markdown
## 2026-06-04 — Flat-file monitor authoring; `name` optional

- Monitors may now be authored as a flat `.claude/monitors/<id>.md` file (id = filename), in
  addition to the folder form `<id>/MONITOR.md` (id = directory). The scanner discovers both;
  markdown assets nested inside a folder monitor are not treated as monitors
  ([001 §scanning](./001-monitor-definition.md)). Verified: `parse-monitor.ts` id derivation and
  `scan-monitors.ts` combined glob.
- `name` is now **optional** in frontmatter and defaults to the monitor id. Minor
  `@agentmonitors/core` changeset.
```

- [ ] **Step 3: Create the changeset**

Create `.changeset/flat-file-monitors.md`:

```markdown
---
'@agentmonitors/core': minor
---

Author monitors as flat `.claude/monitors/<id>.md` files (id derived from the filename), in addition to the folder form `<id>/MONITOR.md`. The scanner discovers both forms (markdown assets nested inside a folder monitor are ignored), and frontmatter `name` is now optional, defaulting to the monitor id.
```

- [ ] **Step 4: Format, link-check, and run the clean verification**

Run: `npx --no-install prettier --write "docs/specs/*.md" ".changeset/*.md"`
Run: `pnpm check`
Expected: PASS (formatting + lint + typecheck).

- [ ] **Step 5: Commit**

```bash
git add docs/specs/001-monitor-definition.md docs/specs/spec-changelog.md .changeset/flat-file-monitors.md
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Document flat-file monitor authoring and optional name"
```

---

## Final verification (before opening the PR)

- [ ] Run `pnpm build && pnpm test && pnpm check` (clean build + lint + test). All pass.
- [ ] Manually sanity-check the new path: in a temp dir, `node apps/cli/dist/index.cjs validate <dir>` against a dir holding a flat `watch-src.md` lists it as a valid monitor with id `watch-src` and (since it omits `name`) display name `watch-src`.

## Self-review notes (author)

- **Spec coverage:** design §3.1 (flat-or-folder) → Tasks 2–3; §3.2 `name` optional → Task 1; docs → Task 4. `event-kind` removal (§3.2) is intentionally a separate plan.
- **Type consistency:** `MonitorDefinition.id` (string) unchanged; `MonitorFrontmatter.name` becomes `string | undefined`; the five display sites use `?? monitor.id` (string). No new types introduced.
- **No placeholders:** every code step shows the exact before/after.
