# Plan D — Body-bearing delivery + the turn-boundary hook + steel-thread UAT (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the loop. At a turn boundary the agent receives the pending event **and the monitor's body-instructions**, as advisory injected context, and acts. Then an automated end-to-end UAT proves "drop a file → agent reacts."

**Architecture:** (1) Core: enrich the delivery claim with the monitor `body` (it's currently dropped). (2) CLI: a `hook deliver` command that claims at a lifecycle point and emits the events + bodies in Claude Code's hook-context format — **advisory, non-blocking** (BP2). (3) An end-to-end UAT built on the `experiments/channel-uat` harness pattern.

**Tech Stack:** TypeScript, the existing claim path (`claimDelivery`/`hook.claim`), Node, vitest. The one external unknown is Claude Code's `PreToolUse` hook-output contract — verify against current Claude Code hook docs before finalizing the output shape (design §10 checkpoint).

**Design source:** [design](../design/2026-06-04-drop-in-monitors-steel-thread.md) §6 (delivery), §7 (handling = body), §11 (the UAT).

**Depends on:** B (the per-workspace daemon + `.local.md` so the hook finds the socket) and C (the plugin that wires the hook). The core enrichment (Task 1) is independent and can land first.

---

## File Structure

| File                                  | Responsibility                                | Change                                  |
| ------------------------------------- | --------------------------------------------- | --------------------------------------- |
| `libs/core/src/runtime/types.ts`      | `DeliveryEventSummary` shape                  | Modify: add `body`                      |
| `libs/core/src/runtime/service.ts`    | `claimDelivery()` populates the claim         | Modify: include `body`                  |
| `libs/core/src/index.ts`              | export surface                                | (no change if type re-exported already) |
| `apps/cli/src/commands/hook.ts`       | Add `hook deliver`                            | Modify                                  |
| `apps/cli/src/hook-deliver-render.ts` | Pure claim → hook-context renderer            | Create                                  |
| `experiments/steel-thread-uat/`       | End-to-end UAT                                | Create                                  |
| Tests                                 | runtime + CLI + render unit tests             | Add                                     |
| Docs                                  | 002 §delivery, 006, spec-changelog, changeset | Modify/Add                              |

---

## Task 1: Enrich the delivery claim with the monitor body (core)

**Files:** `libs/core/src/runtime/types.ts:74-81`, `libs/core/src/runtime/service.ts` (`claimDelivery`, ~lines 256-276), `libs/core/src/runtime/service.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `libs/core/src/runtime/service.test.ts` (reusing the existing high-urgency claim test setup): insert an event whose body is known, claim it, and assert the claim's event summary carries the body:

```ts
it('includes the monitor body in the delivery claim events', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'agentmon-runtime-'));
  tempDirs.push(rootDir);
  const db = createDb(':memory:');
  const runtime = new AgentMonitorRuntime(
    new RuntimeStore(db),
    new SourceRegistry(),
    [claudeCodeAdapter],
  );
  const session = runtime.openSession(
    claudeCodeAdapter.createSessionInput({
      hostSessionId: 'claude-body',
      workspacePath: rootDir,
    }),
  );
  new RuntimeStore(db).insertEvent({
    workspacePath: rootDir,
    monitorId: 'm',
    sourceName: 'manual',
    urgency: 'high',
    title: 'Files changed',
    body: 'Review the diff and flag risky changes.',
    summary: 'Files changed',
    payload: {},
    snapshotMetadata: {},
    snapshotText: null,
    diffText: null,
    objectKey: 'm',
    queryScope: {},
    tags: [],
    createdAt: new Date(Date.now() - 20_000),
  });
  const claim = runtime.claimDelivery(session.id, 'turn-interruptible');
  expect(claim?.events[0]?.body).toBe(
    'Review the diff and flag risky changes.',
  );
});
```

> Note: this test omits `eventKind` (removed in A2). If D lands before A2, add `eventKind: 'mutation'` to the `insertEvent` call.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @mike-north/core exec vitest run src/runtime/service.test.ts -t "includes the monitor body"`
Expected: FAIL — `DeliveryEventSummary` has no `body` field (compile error or `undefined`).

- [ ] **Step 3: Add `body` to the type and populate it**

`libs/core/src/runtime/types.ts` — add to `DeliveryEventSummary` (after `summary`):

```ts
/** The monitor's handling instructions (the event body), for advisory delivery. */
body: string;
```

`libs/core/src/runtime/service.ts` — in `claimDelivery()`, where each `DeliveryEventSummary` is built from an event record, add `body: event.body,` (the field already exists on `MonitorEventRecord`).

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `pnpm --filter @mike-north/core exec vitest run src/runtime/service.test.ts`
Run: `pnpm check`
Expected: PASS. Update the existing claim tests if they assert exact `events[]` object shape (add the `body` field to their expected objects).

- [ ] **Step 5: Commit**

```bash
git add libs/core/src/runtime/types.ts libs/core/src/runtime/service.ts libs/core/src/runtime/service.test.ts
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Carry the monitor body in the delivery claim events"
```

---

## Task 2: Pure renderer — claim → Claude Code hook context

**Files:** Create `apps/cli/src/hook-deliver-render.ts`; Create `apps/cli/src/hook-deliver-render.test.ts`

- [ ] **Step 1: Write the failing test (spec-derived assertions)**

```ts
import { describe, it, expect } from 'vitest';
import { renderHookDelivery } from './hook-deliver-render.js';

describe('renderHookDelivery', () => {
  it('returns no output for a null claim (nothing pending)', () => {
    expect(renderHookDelivery(null)).toBeNull();
  });

  it('renders pending events with their bodies as advisory context', () => {
    const out = renderHookDelivery({
      sessionId: 's',
      mode: 'delivery',
      urgency: 'high',
      lifecycle: 'turn-interruptible',
      message: '1 monitor fired',
      unreadCounts: { low: 0, normal: 0, high: 1, total: 1 },
      events: [
        {
          eventId: 'e1',
          monitorId: 'watch-src',
          title: 'Files changed',
          summary: 'Files changed',
          body: 'Review the diff; flag risky changes.',
          urgency: 'high',
          createdAt: '2026-06-04T00:00:00.000Z',
        },
      ],
    });
    expect(out).not.toBeNull();
    // advisory, non-blocking: the hook decision does not block the tool
    expect(out?.decision).not.toBe('block');
    // the injected context contains the monitor instructions
    expect(out?.context).toContain('watch-src');
    expect(out?.context).toContain('Review the diff; flag risky changes.');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @mike-north/cli exec vitest run src/hook-deliver-render.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the renderer**

`apps/cli/src/hook-deliver-render.ts`:

```ts
import type { DeliveryClaim } from '@mike-north/core';

export interface HookDeliveryOutput {
  /** Advisory only — never 'block' in v1 (BP2: hook delivery is not completion). */
  decision: 'allow';
  /** The additional context injected into the agent at the turn boundary. */
  context: string;
}

/**
 * Render a delivery claim into the additional-context payload a turn-boundary hook
 * emits. Returns null when there is nothing pending. Advisory and non-blocking: the
 * agent is told what changed and what the monitor asks of it, and decides itself.
 */
export function renderHookDelivery(
  claim: DeliveryClaim | null,
): HookDeliveryOutput | null {
  if (!claim || claim.events.length === 0) return null;
  const blocks = claim.events.map(
    (e) => `### ${e.monitorId} (${e.urgency})\n${e.title}\n\n${e.body.trim()}`,
  );
  const context = [
    'AgentMon: monitored changes are pending. Consider handling them before continuing.',
    '',
    ...blocks,
  ].join('\n');
  return { decision: 'allow', context };
}
```

> **External-contract checkpoint:** the exact JSON shape Claude Code expects from a `PreToolUse` hook to inject `additionalContext` (and the field name) must be confirmed against current Claude Code hook docs. `HookDeliveryOutput` is the internal model; Task 3 maps it to the wire format the hook prints to stdout. If the contract uses `additionalContext`/`hookSpecificOutput`, map there; keep this renderer pure and adjust only the printer.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @mike-north/cli exec vitest run src/hook-deliver-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/hook-deliver-render.ts apps/cli/src/hook-deliver-render.test.ts
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Add a pure claim->hook-context renderer (advisory, non-blocking)"
```

---

## Task 3: The `hook deliver` command

**Files:** Modify `apps/cli/src/commands/hook.ts`; Test: `apps/cli/src/commands/cli.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

In a temp workspace with a daemon + a settled high-urgency event + `.local.md` (Plan B), running `agentmonitors hook deliver --lifecycle turn-interruptible` (with `CLAUDE_CODE_SESSION_ID` set) prints hook output whose injected context contains the monitor body:

```ts
it('hook deliver emits the pending monitor body as advisory context', async () => {
  // scaffold ws + monitor + writeLocalState(enabled,socket,db); boot via session start;
  // mutate the watched file; wait for the high-urgency settle;
  const out = runWithEnv(
    ['hook', 'deliver', '--lifecycle', 'turn-interruptible'],
    env,
    ws,
  );
  expect(out.exitCode).toBe(0);
  expect(out.stdout).toContain('watch-files'); // the monitor id
  expect(out.stdout).toContain('When files change'); // the monitor body text
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @mike-north/cli exec vitest run src/commands/cli.integration.test.ts -t "hook deliver emits"`
Expected: FAIL — `hook deliver` does not exist.

- [ ] **Step 3: Implement `hook deliver`**

In `apps/cli/src/commands/hook.ts`, add a `deliver` subcommand that resolves the socket from `.local.md` (Plan B's `readLocalState`), resolves the runtime session id from `$CLAUDE_CODE_SESSION_ID`, calls `claimDeliveryClient(sessionId, lifecycle, socket)`, renders via `renderHookDelivery`, and prints the Claude-Code hook-output JSON to stdout (the format confirmed in the §10 checkpoint), exiting 0 always (graceful: a missing daemon → no output, exit 0):

```ts
hookCommand
  .command('deliver')
  .requiredOption(
    '--lifecycle <lifecycle>',
    'turn-interruptible | turn-idle | post-compact',
  )
  .action(async (options: { lifecycle: DeliveryLifecycle }) => {
    const workspacePath = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
    const hostSessionId = process.env['CLAUDE_CODE_SESSION_ID'];
    if (!hostSessionId) return;
    const state = readLocalState(workspacePath);
    if (
      !state.enabled ||
      !state.socket ||
      !(await daemonAvailable(state.socket))
    )
      return;
    const sessions = await listSessionsClient(state.socket);
    const session = sessions.find((s) => s.hostSessionId === hostSessionId);
    if (!session) return;
    const claim = await claimDeliveryClient(
      session.id,
      options.lifecycle,
      state.socket,
    );
    const rendered = renderHookDelivery(claim);
    if (rendered) process.stdout.write(toClaudeHookOutput(rendered)); // maps to the wire format
  });
```

Add `toClaudeHookOutput(rendered)` — a tiny mapper to the confirmed Claude Code hook stdout JSON (e.g. `{ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: rendered.context } }`). Keep it isolated so the external-contract detail lives in one place.

- [ ] **Step 4: Build + run the integration test**

Run: `pnpm --filter @mike-north/cli build`
Run: `pnpm --filter @mike-north/cli exec vitest run src/commands/cli.integration.test.ts -t "hook deliver emits"`
Expected: PASS.

- [ ] **Step 5: Wire the plugin hooks (Plan C) to `hook deliver`**

Update `agent-plugins/agentmonitors/hooks/claude.yaml` (created in Plan C): `PreToolUse` → `agentmonitors hook deliver --lifecycle turn-interruptible`; `Stop` → `... turn-idle`. Run `pnpm exec aipm build` to regenerate registries; commit the regenerated artifacts.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/hook.ts apps/cli/src/commands/cli.integration.test.ts agent-plugins .claude-plugin
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Add hook deliver: advisory turn-boundary delivery of monitor instructions"
```

---

## Task 4: End-to-end steel-thread UAT (the "done" gate)

**Files:** Create `experiments/steel-thread-uat/{package.json,uat.mjs,README.md}`

- [ ] **Step 1: Write the UAT harness**

Model on `experiments/channel-uat/uat.mjs`. `uat.mjs`:

1. scaffolds a temp workspace with a **flat** monitor `.claude/monitors/watch-src.md` (file-fingerprint, body "When files change, review the diff.") and a `.claude/agentmonitors.local.md` (`enabled: true`, per-workspace socket/db);
2. runs `agentmonitors session start` (boots the daemon detached + registers a session) with `CLAUDE_CODE_SESSION_ID` + `CLAUDE_PROJECT_DIR` set;
3. mutates `watch-src` content;
4. waits for the high-urgency settle, then runs `agentmonitors hook deliver --lifecycle turn-interruptible`;
5. **asserts** the stdout hook output contains both the monitor id `watch-src` and the body text "review the diff";
6. cleans up: `agentmonitors session end`, `daemon stop`, remove the temp dir + socket (await daemon exit; no orphan).

Exit 0 on assertion success, 1 otherwise.

- [ ] **Step 2: Install harness deps + run**

Run: `cd experiments/steel-thread-uat && npm install --no-audit --no-fund`
Run (from repo root, CLI built): `pnpm --filter @mike-north/cli build && node experiments/steel-thread-uat/uat.mjs`
Expected: prints PASS and exits 0; the injected context contains the monitor body. No orphan daemon / stale socket afterward.

- [ ] **Step 3: README + commit**

Write `experiments/steel-thread-uat/README.md` (intent + run instructions, like channel-uat's). Ensure `experiments/steel-thread-uat/node_modules` is gitignored.

```bash
git add experiments/steel-thread-uat/uat.mjs experiments/steel-thread-uat/package.json experiments/steel-thread-uat/package-lock.json experiments/steel-thread-uat/README.md
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Add the end-to-end steel-thread UAT (drop file -> agent reacts)"
```

---

## Task 5: Docs + changeset

**Files:** `docs/specs/002-runtime-delivery.md` (delivery: claim carries body; hook deliver is advisory), `docs/specs/006-agent-integration.md` (the delivery hook + DeliveryEventSummary now includes body — retires the "event_kind/object_key meta" follow-up note re: body), `docs/specs/spec-changelog.md`, `.changeset/delivery-body.md`

- [ ] **Step 1: Update specs**

002: `DeliveryEventSummary` now includes `body`; the turn-boundary delivery hook injects events + bodies as advisory context (BP2). 006: document `hook deliver` and the enriched summary. spec-changelog entry "2026-06-04 — Body-bearing delivery + turn-boundary hook (D)".

- [ ] **Step 2: Changeset**

`.changeset/delivery-body.md`:

```markdown
---
'@mike-north/core': minor
---

Carry the monitor body in `DeliveryEventSummary`, so turn-boundary delivery can surface a monitor's handling instructions (not just its title/summary) to the agent.
```

- [ ] **Step 3: Format + clean verification**

Run: `npx --no-install prettier --write "docs/specs/*.md" ".changeset/*.md"`
Run: `pnpm build && pnpm test && pnpm check`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add docs/specs .changeset/delivery-body.md
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Document body-bearing delivery and the turn-boundary hook"
```

---

## Final verification

- [ ] `node experiments/steel-thread-uat/uat.mjs` exits 0 — the dropped flat monitor's body reaches the agent context after a file change. **This is the campaign's "done" gate.**
- [ ] Manual: install the plugin (Plan C) in a real repo, drop `.claude/monitors/watch-src.md`, change a matching file, and confirm the next turn surfaces the monitor's instructions.
- [ ] `pnpm build && pnpm test && pnpm check` green.

## Self-review notes (author)

- **Spec coverage:** design §6 delivery → Tasks 1–3; §7 (body = handling) → Task 1 + renderer; §11 UAT → Task 4.
- **Type consistency:** `DeliveryEventSummary.body: string` is set in `claimDelivery` and read in `renderHookDelivery`; `HookDeliveryOutput` is internal and mapped once by `toClaudeHookOutput`.
- **External unknown isolated:** the only unverified detail (Claude Code's `PreToolUse` context-injection wire format) is confined to `toClaudeHookOutput`; the renderer and command logic are testable without it.
- **Advisory, not blocking:** `decision: 'allow'` enforces BP2 — delivery never blocks the agent in v1.
