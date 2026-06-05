# Plan B — Lazy project-scoped daemon + `.local.md` coordination + idle reaping (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Claude-Code hooks the verbs to make monitoring "just work": lazily boot a **per-workspace** daemon (detached) when a session starts, register the session, claim deliveries, deregister on session end, and let the daemon self-reap when idle — coordinated through a gitignored `.claude/agentmonitors.local.md`.

**Architecture:** All new surface lives in `apps/cli` (the daemon/IPC layer already exists). Per-workspace isolation comes from deriving a stable socket/db dir from the workspace path and exporting `AGENTMONITORS_SOCKET`/`AGENTMONITORS_DB` (the existing override mechanism) — no core path-resolution change. Two thin lifecycle commands (`session start`, `session end`) wrap detached-spawn + the existing `session.open`/`session.close` IPC. Idle reaping is a small addition to the existing `daemon run` tick loop.

**Tech Stack:** TypeScript, Node `child_process` (detached spawn), `crypto` (sha256), `gray-matter` (`.local.md` frontmatter), the existing Unix-socket IPC, vitest.

**Design source:** [design](../design/2026-06-04-drop-in-monitors-steel-thread.md) §4.2 (lazy daemon), §4.3 (no-restart property), §3.3 (the two file roles).

**Depends on:** A2 (clean schema). Builds on the existing IPC: `session.open/close/list`, `hook.claim`, `daemonAvailable`, `resolveSocketPath`/`resolveDbPath`, `daemon run`.

---

## File Structure

| File                               | Responsibility                                                            | Change                                           |
| ---------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| `apps/cli/src/workspace-paths.ts`  | Derive a stable per-workspace socket/db dir                               | Create                                           |
| `apps/cli/src/local-state.ts`      | Read/write `.claude/agentmonitors.local.md`                               | Create                                           |
| `apps/cli/src/detached-spawn.ts`   | Spawn `daemon run` detached so it outlives a hook                         | Create                                           |
| `apps/cli/src/commands/session.ts` | Add `session start` + `session end` subcommands                           | Modify                                           |
| `apps/cli/src/commands/daemon.ts`  | Idle-reaping in `runLoop` (reuses the existing `runtime.listSessions()`)  | Modify                                           |
| Tests                              | `apps/cli/src/*.test.ts`, `apps/cli/src/commands/cli.integration.test.ts` | Add: derivation, local-state, lifecycle, reaping |

> **No `@mike-north/core` change needed:** the reaper counts open sessions via the existing,
> already-exported `AgentMonitorRuntime.listSessions()`. This plan is CLI-only (changeset-exempt).

---

## Task 1: Per-workspace path derivation

**Files:** Create `apps/cli/src/workspace-paths.ts`; Create `apps/cli/src/workspace-paths.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { workspacePaths } from './workspace-paths.js';

describe('workspacePaths', () => {
  it('derives a stable per-workspace socket + db under the data dir', () => {
    const a = workspacePaths('/Users/me/projects/foo');
    const b = workspacePaths('/Users/me/projects/foo');
    const c = workspacePaths('/Users/me/projects/bar');

    expect(a).toEqual(b); // stable for the same workspace
    expect(a.socket).not.toBe(c.socket); // distinct per workspace
    expect(a.db.endsWith(path.join('inbox.db'))).toBe(true);
    expect(a.socket.endsWith('.sock')).toBe(true);
    // Assert the structural shape, not a homedir prefix — the data root honors
    // XDG_DATA_HOME, which is set in many CI environments and would break a
    // `startsWith(os.homedir())` assertion.
    expect(a.dir).toContain(path.join('agentmonitors', 'workspaces'));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @mike-north/cli exec vitest run src/workspace-paths.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`apps/cli/src/workspace-paths.ts`:

```ts
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface WorkspacePaths {
  /** The per-workspace data directory. */
  dir: string;
  /** The per-workspace SQLite db path. */
  db: string;
  /** The per-workspace Unix socket path. */
  socket: string;
}

/**
 * Derive a stable, per-workspace data directory (and the db + socket inside it)
 * from the absolute workspace path. Two sessions in the same repo share one
 * daemon; two repos get isolated daemons. Mirrors the default data root used by
 * `resolveDbPath`/`resolveSocketPath`, namespaced by a hash of the workspace.
 */
export function workspacePaths(workspacePath: string): WorkspacePaths {
  const hash = createHash('sha256')
    .update(path.resolve(workspacePath))
    .digest('hex')
    .slice(0, 16);
  const dataRoot =
    process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share');
  const dir = path.join(dataRoot, 'agentmonitors', 'workspaces', hash);
  return {
    dir,
    db: path.join(dir, 'inbox.db'),
    // Keep the socket short: a 16-char hash under the data dir stays well under
    // the 100-char limit on most setups; resolveSocketPath's /tmp fallback still
    // applies if a deep home dir pushes it over.
    socket: path.join(dir, 'agentmonitors.sock'),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @mike-north/cli exec vitest run src/workspace-paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/workspace-paths.ts apps/cli/src/workspace-paths.test.ts
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Derive a stable per-workspace daemon socket + db dir"
```

---

## Task 2: The `.claude/agentmonitors.local.md` coordination file

**Files:** Create `apps/cli/src/local-state.ts`; Create `apps/cli/src/local-state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLocalState, writeLocalState } from './local-state.js';

describe('local-state', () => {
  it('returns enabled:false when the file is absent (quick-exit default)', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-ls-'));
    try {
      expect(readLocalState(ws).enabled).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('round-trips enabled + socket + db + reapAfterMs', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-ls-'));
    try {
      writeLocalState(ws, {
        enabled: true,
        socket: '/x/a.sock',
        db: '/x/i.db',
        reapAfterMs: 300000,
      });
      const state = readLocalState(ws);
      expect(state).toEqual({
        enabled: true,
        socket: '/x/a.sock',
        db: '/x/i.db',
        reapAfterMs: 300000,
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('treats a present-but-enabled:false file as disabled', () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-ls-'));
    try {
      // Use writeLocalState (which creates `.claude/`) so the test reliably
      // exercises the enabled:false parse path — never throwing on a missing dir.
      writeLocalState(ws, { enabled: false });
      expect(readLocalState(ws).enabled).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @mike-north/cli exec vitest run src/local-state.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`apps/cli/src/local-state.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

export interface LocalState {
  enabled: boolean;
  socket?: string;
  db?: string;
  reapAfterMs?: number;
}

const DEFAULT_REAP_AFTER_MS = 5 * 60 * 1000;

function filePath(workspacePath: string): string {
  return path.join(workspacePath, '.claude', 'agentmonitors.local.md');
}

/** Read the per-project coordination file. Absent/unparseable → disabled (quick-exit). */
export function readLocalState(workspacePath: string): LocalState {
  let raw: string;
  try {
    raw = readFileSync(filePath(workspacePath), 'utf-8');
  } catch {
    return { enabled: false };
  }
  let data: Record<string, unknown>;
  try {
    data = matter(raw).data as Record<string, unknown>;
  } catch {
    return { enabled: false };
  }
  const reap = data['reap-after-ms'];
  return {
    enabled: data['enabled'] === true,
    ...(typeof data['socket'] === 'string' ? { socket: data['socket'] } : {}),
    ...(typeof data['db'] === 'string' ? { db: data['db'] } : {}),
    reapAfterMs: typeof reap === 'number' ? reap : DEFAULT_REAP_AFTER_MS,
  };
}

/** Write the coordination file (creates `.claude/`). Frontmatter only. */
export function writeLocalState(
  workspacePath: string,
  state: LocalState,
): void {
  const target = filePath(workspacePath);
  mkdirSync(path.dirname(target), { recursive: true });
  const lines = [
    '---',
    `enabled: ${String(state.enabled)}`,
    ...(state.socket ? [`socket: ${state.socket}`] : []),
    ...(state.db ? [`db: ${state.db}`] : []),
    `reap-after-ms: ${String(state.reapAfterMs ?? DEFAULT_REAP_AFTER_MS)}`,
    '---',
    '',
    '> Local AgentMon coordination state. Gitignored; safe to delete (it is regenerated).',
    '',
  ];
  writeFileSync(target, lines.join('\n'), 'utf-8');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @mike-north/cli exec vitest run src/local-state.test.ts`
Expected: PASS (first two cases; the third is best-effort and tolerant).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/local-state.ts apps/cli/src/local-state.test.ts
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Add the .claude/agentmonitors.local.md coordination reader/writer"
```

---

## Task 3: Detached daemon spawn helper

**Files:** Create `apps/cli/src/detached-spawn.ts`; Create `apps/cli/src/detached-spawn.test.ts`

- [ ] **Step 1: Write the failing test (UAT-style — the riskiest mechanic)**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnDetachedDaemon } from './detached-spawn.js';
import { daemonAvailable, callDaemon } from './daemon-ipc.js';

describe('spawnDetachedDaemon', () => {
  it('boots a daemon that survives the spawning call and answers on the socket', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'agentmon-spawn-'));
    const socket = path.join(ws, 'd.sock');
    const db = path.join(ws, 'i.db');
    try {
      spawnDetachedDaemon({
        monitorsDir: path.join(ws, '.claude', 'monitors'),
        workspacePath: ws,
        socket,
        db,
        pollMs: 1000,
      });
      // poll until the daemon answers (it was spawned detached, not awaited)
      const start = Date.now();
      let up = false;
      while (Date.now() - start < 10000) {
        if (await daemonAvailable(socket)) {
          up = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(up).toBe(true);
    } finally {
      try {
        await callDaemon('stop', {}, { socketPath: socket });
      } catch {
        /* ignore */
      }
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @mike-north/cli exec vitest run src/detached-spawn.test.ts`
Expected: FAIL — module does not exist. (Requires the CLI to be built: `pnpm --filter @mike-north/cli build` first, since the helper spawns the built binary.)

- [ ] **Step 3: Implement**

`apps/cli/src/detached-spawn.ts`:

```ts
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface SpawnDaemonOptions {
  monitorsDir: string;
  workspacePath: string;
  socket: string;
  db: string;
  pollMs?: number;
}

/** Absolute path to this CLI's built entrypoint (the bin). */
function cliEntry(): string {
  // This file is bundled into dist/index.cjs; __dirname-equivalent resolves to dist/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'index.cjs');
}

/**
 * Spawn `agentmonitors daemon run` as a DETACHED background process so it
 * outlives the short-lived hook that booted it. stdio is fully ignored and the
 * child is unref'd so the parent can exit immediately.
 */
export function spawnDetachedDaemon(options: SpawnDaemonOptions): void {
  const child = spawn(
    process.execPath,
    [
      cliEntry(),
      'daemon',
      'run',
      options.monitorsDir,
      '--workspace',
      options.workspacePath,
      '--socket',
      options.socket,
      '--poll-ms',
      String(options.pollMs ?? 30000),
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        AGENTMONITORS_DB: options.db,
        AGENTMONITORS_SOCKET: options.socket,
      },
    },
  );
  child.unref();
}
```

> If `import.meta.url` is unavailable in the tsup CJS bundle, fall back to `__dirname` (tsup provides it in CJS output). Verify the bundled `cliEntry()` resolves to the real `dist/index.cjs` during Step 4; adjust the `path.join` depth if tsup emits to a nested dir.

- [ ] **Step 4: Build, then run to verify it passes**

Run: `pnpm --filter @mike-north/cli build`
Run: `pnpm --filter @mike-north/cli exec vitest run src/detached-spawn.test.ts`
Expected: PASS — daemon comes up on the socket and is stopped in cleanup. Confirm no orphan: `pgrep -fl "daemon run"` shows nothing afterward.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/detached-spawn.ts apps/cli/src/detached-spawn.test.ts
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Add a detached daemon-spawn helper that survives the booting hook"
```

---

## Task 4: `session start` and `session end` lifecycle commands

**Files:** Modify `apps/cli/src/commands/session.ts`; Test: `apps/cli/src/commands/cli.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Add to `cli.integration.test.ts` a test that, in a temp workspace with a `file-fingerprint` monitor and a `writeLocalState(ws, { enabled: true, socket, db })` coordination file:

```ts
it('session start boots a per-workspace daemon and registers the session', async () => {
  // ... scaffold temp ws + monitor + writeLocalState(ws, {enabled:true, socket, db}) ...
  const start = runWithEnv(['session', 'start'], env, ws); // env has CLAUDE_CODE_SESSION_ID + CLAUDE_PROJECT_DIR=ws
  expect(start.exitCode).toBe(0);

  // daemon is up on the per-workspace socket; the session is registered
  // poll daemonAvailable(socket) then session list
  const list = runWithEnv(
    ['session', 'list', '--socket', socket, '--format', 'json'],
    env,
    ws,
  );
  expect(JSON.parse(list.stdout).some((s) => s.workspacePath === ws)).toBe(
    true,
  );

  const end = runWithEnv(['session', 'end'], env, ws);
  expect(end.exitCode).toBe(0);
  // cleanup: agentmonitors daemon stop --socket socket
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @mike-north/cli exec vitest run src/commands/cli.integration.test.ts -t "session start boots"`
Expected: FAIL — `session start` is not a command yet.

- [ ] **Step 3: Implement `session start` / `session end`**

In `apps/cli/src/commands/session.ts`, add two subcommands. `start`:

```ts
sessionCommand
  .command('start')
  .description(
    'Lazy-boot the project daemon (if needed) and register this session',
  )
  .action(async () => {
    const workspacePath = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
    const hostSessionId = process.env['CLAUDE_CODE_SESSION_ID'];
    if (!hostSessionId) return; // not a Claude session; nothing to do

    const state = readLocalState(workspacePath);
    if (!state.enabled) return; // quick-exit: monitoring not enabled here

    const paths = workspacePaths(workspacePath);
    const socket = state.socket ?? paths.socket;
    const db = state.db ?? paths.db;
    const monitorsDir = path.join(workspacePath, '.claude', 'monitors');

    if (!(await daemonAvailable(socket))) {
      spawnDetachedDaemon({ monitorsDir, workspacePath, socket, db });
      // wait briefly for the socket to come up
      const start = Date.now();
      while (Date.now() - start < 8000 && !(await daemonAvailable(socket))) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    // persist the resolved paths for sibling hooks (deliver/end)
    writeLocalState(workspacePath, { ...state, socket, db });

    await openSessionClient(
      claudeCodeAdapter.createSessionInput({ hostSessionId, workspacePath }),
      socket,
    );
  });
```

`end`:

```ts
sessionCommand
  .command('end')
  .description('Deregister this session (lets the idle daemon reap itself)')
  .action(async () => {
    const workspacePath = process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
    const hostSessionId = process.env['CLAUDE_CODE_SESSION_ID'];
    if (!hostSessionId) return;
    const state = readLocalState(workspacePath);
    if (!state.enabled || !state.socket) return;
    if (!(await daemonAvailable(state.socket))) return;
    // resolve this host session's runtime id, then close it
    const sessions = await listSessionsClient(state.socket);
    const match = sessions.find((s) => s.hostSessionId === hostSessionId);
    if (match) await closeSessionClient(match.id, state.socket);
  });
```

Add the necessary imports (`readLocalState`/`writeLocalState`, `workspacePaths`, `spawnDetachedDaemon`, `daemonAvailable`, `openSessionClient`/`listSessionsClient`/`closeSessionClient`, `claudeCodeAdapter`, `path`).

- [ ] **Step 4: Build + run the integration test**

Run: `pnpm --filter @mike-north/cli build`
Run: `pnpm --filter @mike-north/cli exec vitest run src/commands/cli.integration.test.ts -t "session start boots"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/session.ts apps/cli/src/commands/cli.integration.test.ts
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Add session start/end lifecycle commands (lazy boot + register/deregister)"
```

---

## Task 5: Idle reaping in `daemon run`

**Files:** Modify `apps/cli/src/commands/daemon.ts`; Modify `libs/core/src/runtime/service.ts` (a `countOpenSessions(workspacePath)` accessor if one is not already reachable); Test: `apps/cli/src/commands/cli.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Extend the lifecycle test: after `session end`, with a short `--reap-after-ms 1500`, the daemon process exits on its own:

```ts
it('the daemon idle-reaps itself after the last session ends', async () => {
  // boot via session start (reap-after-ms short), then session end,
  // then poll daemonAvailable(socket) until false within ~4s.
  // assert it becomes unavailable (the daemon exited).
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @mike-north/cli exec vitest run src/commands/cli.integration.test.ts -t "idle-reaps"`
Expected: FAIL — the daemon runs forever today.

- [ ] **Step 3: Implement reaping in `runLoop`**

Add a `--reap-after-ms <ms>` option to `daemon run` (default 300000; `0` disables). In the tick loop, after refreshing sessions, check the runtime's open-session count for the workspace; if it has been zero continuously for `reapAfterMs`, set `stopping = true` and break (reuse the existing `stop()` path). Track an `idleSince: number | null` across iterations:

```ts
// inside runLoop, after the tick:
const open = runtime
  .listSessions()
  .filter(
    (s) => s.workspacePath === workspacePath && s.status === 'active',
  ).length;
if (open === 0) {
  idleSince ??= Date.now();
  if (reapAfterMs > 0 && Date.now() - idleSince >= reapAfterMs) {
    stop();
  }
} else {
  idleSince = null;
}
```

If `listSessions()` is not exposed on the runtime used here, add a thin pass-through (it already exists on `AgentMonitorRuntime`). Keep the poll interval short enough that reaping is responsive (the existing `--poll-ms` governs the check cadence).

- [ ] **Step 4: Build + run the reaping test + full suite**

Run: `pnpm --filter @mike-north/cli build`
Run: `pnpm --filter @mike-north/cli exec vitest run --exclude "**/*.docker.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/daemon.ts libs/core/src/runtime/service.ts apps/cli/src/commands/cli.integration.test.ts
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Idle-reap the daemon after its last workspace session ends"
```

---

## Task 6: Docs + changeset

**Files:** `docs/specs/002-runtime-delivery.md` (§10 daemon — add lazy-boot + per-workspace + reaping), `docs/specs/005-cli-reference.md` (document `session start`/`session end` + `--reap-after-ms`), `docs/specs/spec-changelog.md`, `.changeset/lazy-daemon.md`

- [ ] **Step 1: Update 002 §10 and 005**

002: document that hooks lazy-boot a per-workspace daemon (socket/db derived from the workspace), and that the daemon idle-reaps after its last session ends. 005: add the `session start` and `session end` subcommands (in-process boot + socket register/deregister) and the `daemon run --reap-after-ms` flag; add rows to the command inventory.

- [ ] **Step 2: Changelog + changeset**

spec-changelog entry "2026-06-04 — Lazy project-scoped daemon (B)" summarizing the above. `.changeset/lazy-daemon.md`: `@mike-north/cli` is changeset-exempt; if `service.ts` gained a public accessor, add a minor `@mike-north/core` changeset, otherwise note "CLI-only, no changeset" in the changelog.

- [ ] **Step 3: Format + clean verification**

Run: `npx --no-install prettier --write "docs/specs/*.md" ".changeset/*.md"`
Run: `pnpm build && pnpm test && pnpm check`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add docs/specs .changeset
git commit --author="Mike North <michael.l.north@gmail.com>" -m "Document the lazy project-scoped daemon (session start/end + reaping)"
```

---

## Final verification

- [ ] Two different temp workspaces booted via `session start` get **different** sockets/dbs (`session list --socket <each>` shows only that workspace's session).
- [ ] After `session end`, `pgrep -fl "daemon run"` shows the reaped daemon gone within `reap-after-ms`.
- [ ] `pnpm build && pnpm test && pnpm check` green; no orphan daemons or stale sockets left by the test suite.

## Self-review notes (author)

- **Spec coverage:** design §4.2 → Tasks 3–5; §4.3 (no-restart) is preserved because the daemon re-scans monitor files each tick (no plan change needed); §3.3 `.local.md` → Task 2.
- **Type consistency:** `workspacePaths()` returns `{dir, db, socket}` used identically in `detached-spawn` and `session start`; `LocalState` fields (`enabled/socket/db/reapAfterMs`) are consistent across reader/writer and the `session start` consumer.
- **Risk:** the detached-spawn helper (Task 3) is the load-bearing new mechanic and has a dedicated survival UAT; the `cliEntry()` path resolution must be verified against the real tsup output in Step 4.
