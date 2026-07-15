#!/usr/bin/env node
/**
 * Fresh-environment install-to-first-signal E2E proof (hooks path).
 *
 * Proves the product works the way a brand-new user experiences it — not the
 * way the repo's own workspace-linked test suites exercise it: pack the
 * publishable packages, install the `agentmonitors` launcher globally from
 * those packed tarballs (the README's documented `npm install -g
 * agentmonitors`), then in a fresh temp project — enable monitoring, scaffold
 * a `file-fingerprint` monitor, start a daemon, open a lead session, touch
 * the watched file, and confirm the resulting signal is both queryable
 * (`events list --unread`) and deliverable through the real hook contract
 * (`hook deliver` fed a real Claude Code `UserPromptSubmit` stdin payload —
 * docs/specs/006-agent-integration.md §5). No MCP/channel path is exercised
 * (issue #276 non-goal); only `init`, `daemon`, `session`, `events`, and
 * `hook` subcommands are invoked.
 *
 * Hermeticity (issue #276 AC1/AC4): every publishable package
 * (`PACKAGE_DIRS`, scripts/publish-release-packages.mjs — core, all bundled
 * `source-*` plugins, the CLI, and the launcher) is packed via `npm pack` and
 * installed together in a single `npm install -g --prefix <isolated>`
 * invocation, so npm resolves every `@agentmonitors/*` inter-dependency
 * (declared in package.json even though tsup inlines them into the CLI's
 * bundle) from the local tarballs instead of the public registry — the run
 * never depends on this exact version already being published, and never
 * silently tests a different (stale) published version. Genuine third-party
 * registry dependencies (better-sqlite3, commander, zod, …) are still
 * fetched from npm, which issue #276 AC4 explicitly allows. The install
 * target is an isolated npm prefix + HOME + caches, and the project under
 * test lives entirely in the OS temp dir, outside the repo tree — nothing
 * here can observe or fall back to the workspace's own `node_modules`.
 *
 * Both `@agentmonitors/cli` and the `agentmonitors` launcher package declare
 * a `agentmonitors` bin — installing them together makes npm link the bin
 * name to whichever package sorts first ("@" sorts before "a", so
 * `@agentmonitors/cli` always wins). To actually exercise the launcher's own
 * `require.resolve` indirection under a real global nested-node_modules
 * layout — the whole reason this test exists — every CLI invocation below
 * runs the launcher package's installed entry point directly (`node
 * <prefix>/lib/node_modules/agentmonitors/bin/agentmonitors.cjs`) rather
 * than the collided `<prefix>/bin/agentmonitors` symlink. See the
 * "confirm the bin-name collision" step for the assertion that keeps this
 * honest if npm's tie-break behavior ever changes.
 *
 * Governing references: scripts/test-standalone-consumer.mjs (the
 * pack-and-install precedent this script follows for packing/hermeticity;
 * `packPackage` itself now lives in scripts/lib/pack-helpers.mjs, shared by
 * both scripts), agent-plugins/agentmonitors/skills/setup-monitors/SKILL.md
 * "Reliable manual-test recipe" (explicit socket, `--reap-after-ms 0`, fast
 * `--poll-ms`, isolated `AGENTMONITORS_DB`, settle-window waits with
 * margin).
 *
 * @see ../docs/specs/006-agent-integration.md §5 (hook stdin/stdout contract)
 * @see ../docs/specs/002-runtime-delivery.md §9.1 (15s high-urgency claim-time settle window)
 * @see ../docs/specs/002-runtime-delivery.md §10.4 (daemon IPC wire protocol)
 * @see ../docs/specs/002-runtime-delivery.md §10.5 (the `daemon.tick` method used to force a deterministic baseline)
 */
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packPackage } from './lib/pack-helpers.mjs';
import { PACKAGE_DIRS } from './publish-release-packages.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// docs/specs/002-runtime-delivery.md §9.1: `claimDelivery`'s turn-interruptible
// high-urgency branch only surfaces events that have aged past this hardcoded
// claim-time settle window — independent of the monitor's own `notify`
// settle-for. No CLI flag shortens it, so the polling timeout below must
// clear it with margin.
const HIGH_URGENCY_SETTLE_MS = 15_000;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Run a command to completion, throwing with full stdout/stderr on failure
 * so a broken step is diagnosable from CI logs alone (issue #276 AC2).
 * Pass `options.input` to feed stdin (used for the hook commands, which read
 * their real Claude Code payload from stdin — never env vars); omitting it
 * closes stdin instead, which is correct for every other command here. */
function run(command, args, options = {}) {
  const { input, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio:
      input === undefined
        ? ['ignore', 'pipe', 'pipe']
        : ['pipe', 'pipe', 'pipe'],
    ...spawnOptions,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error) {
    throw new Error(
      `Spawn error running ${command} ${args.join(' ')}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Command failed (exit ${String(result.status)}, signal ${String(result.signal)}): ${command} ${args.join(' ')}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  return result;
}

const stepTimings = [];

/** Named-step wrapper (issue #276 AC2: fail loudly, naming which step
 * broke). Times every step so the final summary can report and justify the
 * measured runtime (AC3). */
async function step(name, fn) {
  const start = Date.now();
  console.log(`\n=== ${name} ===`);
  try {
    const result = await fn();
    const elapsedMs = Date.now() - start;
    stepTimings.push({ name, elapsedMs, ok: true });
    console.log(`--- done in ${(elapsedMs / 1000).toFixed(1)}s: ${name} ---`);
    return result;
  } catch (error) {
    const elapsedMs = Date.now() - start;
    stepTimings.push({ name, elapsedMs, ok: false });
    const message = error instanceof Error ? error.message : String(error);
    const failure = new Error(
      `Step "${name}" failed after ${(elapsedMs / 1000).toFixed(1)}s: ${message}`,
    );
    failure.cause = error;
    throw failure;
  }
}

/** Poll `checkFn` until it returns `{ ok: true, value }`, or throw a timeout
 * error carrying the last observed detail (AC4: no flaky fixed sleeps —
 * every wait here is a bounded retry loop with margin, per the
 * setup-monitors skill's "Reliable manual-test recipe"). */
async function waitFor(description, checkFn, { timeoutMs, intervalMs = 1000 }) {
  const start = Date.now();
  let lastDetail = '(no attempts made)';
  for (;;) {
    const outcome = await checkFn();
    if (outcome.ok) {
      return outcome.value;
    }
    lastDetail = outcome.detail ?? lastDetail;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `Timed out after ${(timeoutMs / 1000).toFixed(1)}s waiting for: ${description}. Last observed: ${lastDetail}`,
      );
    }
    await sleep(intervalMs);
  }
}

/** Patch the scaffolded `file-fingerprint` MONITOR.md for a fast, bounded
 * test cycle: a 1s observe interval and a 3s debounce settle-for, per the
 * setup-monitors skill's "Fast-test setup: shorten intervals before
 * verifying". This does not touch the separate, unconfigurable 15s
 * high-urgency claim-time settle window ({@link HIGH_URGENCY_SETTLE_MS}). */
function speedUpMonitorForTesting(monitorPath) {
  let content = readFileSync(monitorPath, 'utf-8');
  const withInterval = content.replace(
    '  type: file-fingerprint\n',
    '  type: file-fingerprint\n  interval: 1s\n',
  );
  if (withInterval === content) {
    throw new Error(
      `Could not find "  type: file-fingerprint" line to patch in ${monitorPath}`,
    );
  }
  content = withInterval;
  const withNotify = content.replace(
    'urgency: high\n',
    'notify:\n  strategy: debounce\n  settle-for: 3s\nurgency: high\n',
  );
  if (withNotify === content) {
    throw new Error(
      `Could not find "urgency: high" line to patch in ${monitorPath}`,
    );
  }
  writeFileSync(monitorPath, withNotify, 'utf-8');
}

/**
 * Resolve a file inside a globally-`npm install`ed package, given the
 * `--prefix` directory the install used. npm's global layout nests installed
 * packages under `<prefix>/lib/node_modules/<name>` on POSIX and
 * `<prefix>/node_modules/<name>` on win32 (no `lib/` there) — this is the
 * real installed package directory, distinct from the `<prefix>/bin/*` bin
 * shims/symlinks npm also generates (which, for a bin-name collision like
 * this test's, may not point at the package you actually want).
 */
function resolveInstalledPackageFile(prefixDir, packageName, ...relativeParts) {
  const nodeModulesDir =
    process.platform === 'win32'
      ? path.join(prefixDir, 'node_modules')
      : path.join(prefixDir, 'lib', 'node_modules');
  return path.join(nodeModulesDir, packageName, ...relativeParts);
}

/**
 * Send a single request over the daemon's Unix-socket IPC and resolve with
 * its `result` — the newline-delimited JSON protocol documented in
 * docs/specs/002-runtime-delivery.md §10.4: "Each request/response is a
 * single newline-delimited JSON object." `daemon.tick` (§10.5) is the only
 * method this script ever calls this way; every other daemon interaction
 * goes through the installed launcher binary, the real user-facing surface
 * this test exists to prove. `daemon.tick` has no CLI-exposed passthrough —
 * `agentmonitors daemon once` builds a *separate* in-process runtime against
 * the same db file rather than ticking the already-running daemon
 * (apps/cli/src/runtime-client.ts `daemonTickClient`), so it cannot force
 * *this* daemon process's own tick. The daemon server dispatches
 * `daemon.tick` against the exact same `runtime` instance its own poll loop
 * uses (apps/cli/src/daemon-ipc.ts `handleRequest`), so awaiting this call
 * is a hard guarantee that one real tick has run and completed before this
 * function resolves.
 */
function callDaemonIpc(socketPath, method, params, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const request = {
      id: `e2e-${method}-${String(Date.now())}`,
      method,
      params,
    };
    let buffer = '';
    let settled = false;
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      finish(() => {
        socket.destroy();
        reject(
          new Error(
            `Timed out after ${String(timeoutMs)}ms waiting for a "${method}" response on ${socketPath}`,
          ),
        );
      });
    }, timeoutMs);
    function finish(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      fn();
    }
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const raw = buffer.slice(0, newline);
      finish(() => {
        socket.end();
        let response;
        try {
          response = JSON.parse(raw);
        } catch (error) {
          reject(
            new Error(
              `Could not parse daemon IPC response to "${method}" as JSON: ${raw} (${error instanceof Error ? error.message : String(error)})`,
            ),
          );
          return;
        }
        if (response.error) {
          reject(
            new Error(
              `Daemon IPC method "${method}" failed: ${String(response.error)}`,
            ),
          );
          return;
        }
        resolve(response.result);
      });
    });
    socket.on('error', (error) => {
      finish(() => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });
}

/**
 * Retry `fn` up to `attempts` times with `delayMs` between tries. Reserved
 * for the FIRST CLI invocation that talks to the daemon over the socket
 * (`session open`): `existsSync(socketPath)` only proves the socket *file*
 * exists, not that the daemon has finished `listen()` and is ready to
 * `accept()` a connection — bind-then-listen is not provably atomic across
 * processes. Every socket call after the first one runs only once this call
 * has already succeeded once, so it does not need its own retry.
 */
async function retryOnce(
  description,
  fn,
  { attempts = 3, delayMs = 500 } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(
          `${description}: attempt ${String(attempt)}/${String(attempts)} failed (${error instanceof Error ? error.message : String(error)}); retrying in ${String(delayMs)}ms...`,
        );
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

/**
 * Print the last `maxLines` of the daemon's captured stdout/stderr directly
 * to this script's own stdout/stderr. The full log is also written to
 * `daemonLogPath` for local reruns, but on an ephemeral CI runner the job's
 * filesystem is gone once it ends — the path alone does not satisfy "a
 * broken step is diagnosable from CI logs alone" (issue #276 AC2) unless the
 * content itself is in the log.
 */
function printDaemonLogTail(daemonLogChunks, daemonLogPath, maxLines = 100) {
  const fullLog = Buffer.concat(
    daemonLogChunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))),
  ).toString('utf-8');
  const lines = fullLog.length > 0 ? fullLog.split('\n') : [];
  const tail = lines.slice(-maxLines);
  console.error(
    `\n=== daemon log tail (last ${String(tail.length)} of ${String(lines.length)} line(s); full log at ${daemonLogPath}) ===`,
  );
  console.error(
    tail.length > 0 ? tail.join('\n') : '(daemon produced no output)',
  );
  console.error('=== end daemon log tail ===\n');
}

async function main() {
  const overallStart = Date.now();

  await step('build workspace packages', () => {
    run(PNPM_BIN, ['build'], { cwd: REPO_ROOT });
  });

  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'am-e2e-hooks-'));
  const packDir = path.join(tmpRoot, 'packed');
  const npmPrefixDir = path.join(tmpRoot, 'npm-global');
  const npmCacheDir = path.join(tmpRoot, 'npm-cache');
  const nodeGypDir = path.join(tmpRoot, 'node-gyp');
  const fakeHome = path.join(tmpRoot, 'home');
  const xdgCacheDir = path.join(tmpRoot, 'xdg-cache');
  const projectDir = path.join(tmpRoot, 'project');
  const socketPath = path.join(tmpRoot, 'd.sock');
  const dbPath = path.join(tmpRoot, 'agentmon.db');
  const daemonLogPath = path.join(tmpRoot, 'daemon.log');
  for (const dir of [
    packDir,
    npmPrefixDir,
    npmCacheDir,
    nodeGypDir,
    fakeHome,
    xdgCacheDir,
    projectDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  console.log(`Isolated temp root (outside the repo tree): ${tmpRoot}`);

  const installEnv = {
    ...process.env,
    HOME: fakeHome,
    npm_config_cache: npmCacheDir,
    npm_config_devdir: nodeGypDir,
    XDG_CACHE_HOME: xdgCacheDir,
  };

  const tarballs = await step(
    'pack every publishable package (npm pack precedent)',
    () =>
      PACKAGE_DIRS.map((dir) =>
        packPackage(path.join(REPO_ROOT, dir), packDir),
      ),
  );
  console.log(
    `Packed ${String(tarballs.length)} tarballs from PACKAGE_DIRS:\n${tarballs.map((t) => `  - ${path.basename(t)}`).join('\n')}`,
  );

  await step(
    'hermeticity guard: packed tarballs carry no residual workspace: protocol refs',
    () => {
      for (const tarball of tarballs) {
        const inspected = run(
          'tar',
          ['-xzOf', tarball, 'package/package.json'],
          { cwd: packDir },
        );
        if (inspected.stdout.includes('workspace:')) {
          throw new Error(
            `${path.basename(tarball)}'s package.json still contains an unrewritten workspace: protocol reference:\n${inspected.stdout}`,
          );
        }
      }
    },
  );

  await step(
    'install the agentmonitors launcher globally from the packed tarballs (isolated prefix, no workspace node_modules access)',
    () => {
      run(
        NPM_BIN,
        [
          'install',
          '--global',
          '--prefix',
          npmPrefixDir,
          '--no-audit',
          '--no-fund',
          ...tarballs,
        ],
        { cwd: packDir, env: installEnv },
      );
    },
  );

  // The bin symlink/shim npm generated for the "agentmonitors" name. Both
  // `@agentmonitors/cli` and the `agentmonitors` launcher package declare
  // this same bin name, so this path is NOT reliably the launcher — see the
  // "confirm the bin-name collision" step below. Kept only for that
  // assertion; every CLI invocation in this script instead goes through
  // `launcherEntryPoint`.
  const agentmonitorsBinSymlink = path.join(
    npmPrefixDir,
    process.platform === 'win32' ? 'agentmonitors.cmd' : 'bin/agentmonitors',
  );
  if (!existsSync(agentmonitorsBinSymlink)) {
    throw new Error(
      `Expected the global install to produce a binary at ${agentmonitorsBinSymlink}, but it does not exist.`,
    );
  }

  // The `agentmonitors` launcher package's OWN installed entry point (its
  // `bin/agentmonitors.cjs`, which does `require.resolve('@agentmonitors/cli/package.json')`
  // and re-execs into it). Invoking this file directly — rather than the
  // possibly-collided bin symlink above — is what actually exercises that
  // require.resolve indirection under a real global nested-node_modules
  // layout, which is the entire point of this test (issue #276).
  const launcherEntryPoint = resolveInstalledPackageFile(
    npmPrefixDir,
    'agentmonitors',
    'bin',
    'agentmonitors.cjs',
  );
  if (!existsSync(launcherEntryPoint)) {
    throw new Error(
      `Expected the global install to place the agentmonitors launcher package's own entry point at ${launcherEntryPoint}, but it does not exist.`,
    );
  }

  await step(
    'confirm the bin-name collision this test routes around (both @agentmonitors/cli and the agentmonitors launcher declare a "agentmonitors" bin)',
    () => {
      if (process.platform === 'win32') {
        console.log(
          'Skipping the readlink assertion on win32: npm places a generated .cmd/.ps1 shim there instead of a symlink, so there is nothing to readlink. Every invocation below still runs the launcher entry point directly, independent of this platform difference.',
        );
        return;
      }
      const target = readlinkSync(agentmonitorsBinSymlink);
      if (!target.includes(path.join('@agentmonitors', 'cli'))) {
        throw new Error(
          `Expected npm's global "agentmonitors" bin symlink to resolve into @agentmonitors/cli — installing both it and the "agentmonitors" launcher package in one "npm install --global" makes npm link the "agentmonitors" bin name to whichever package sorts first ("@" sorts before "a", so @agentmonitors/cli always wins) — but it points at: ${target}. This assertion exists so that if npm's tie-break behavior ever changes, this test fails loudly rather than silently going back to testing the CLI's own bin directly. Every invocation below deliberately runs the launcher package's own installed entry point (${launcherEntryPoint}) via \`node <path>\`, specifically to exercise the launcher's require.resolve indirection.`,
        );
      }
      console.log(
        `Confirmed: the global "agentmonitors" bin symlink resolves to @agentmonitors/cli (${target}), not the agentmonitors launcher package — exactly the collision this test routes around by invoking ${launcherEntryPoint} directly.`,
      );
    },
  );

  /** Run the installed launcher's own entry point (never the possibly-collided
   * bin symlink) — see the module doc comment and the bin-collision step
   * above for why. */
  const runLauncher = (args, options = {}) =>
    run(process.execPath, [launcherEntryPoint, ...args], options);

  await step(
    'sanity-check the installed CLI reports this build (not a stale global install)',
    () => {
      const localCliPackageJson = JSON.parse(
        readFileSync(
          path.join(REPO_ROOT, 'apps', 'cli', 'package.json'),
          'utf-8',
        ),
      );
      const versionResult = runLauncher(['--version'], { env: installEnv });
      const installedVersion = versionResult.stdout.trim();
      if (installedVersion !== localCliPackageJson.version) {
        throw new Error(
          `Installed agentmonitors --version "${installedVersion}" does not match the local repo's apps/cli version "${String(localCliPackageJson.version)}" — the global install did not resolve to this build.`,
        );
      }
      console.log(`Installed agentmonitors --version: ${installedVersion}`);
    },
  );

  const cliEnv = { ...process.env, HOME: fakeHome };
  const runCli = (args) => runLauncher(args, { cwd: projectDir, env: cliEnv });

  await step('enable the project (agentmonitors init --enable-only)', () => {
    runCli(['init', '--enable-only']);
    const localStatePath = path.join(
      projectDir,
      '.claude',
      'agentmonitors.local.md',
    );
    if (!existsSync(localStatePath)) {
      throw new Error(
        `Expected ${localStatePath} to exist after "init --enable-only".`,
      );
    }
  });

  const watchedFilePath = path.join(projectDir, 'watched.txt');
  writeFileSync(watchedFilePath, 'first\n', 'utf-8');

  const monitorPath = path.join(
    projectDir,
    '.claude',
    'monitors',
    'watch-file',
    'MONITOR.md',
  );
  await step('scaffold a file-fingerprint monitor', () => {
    runCli([
      'init',
      'watch-file',
      '--type',
      'file-fingerprint',
      '--glob',
      'watched.txt',
      '--urgency',
      'high',
    ]);
    if (!existsSync(monitorPath)) {
      throw new Error(`Expected ${monitorPath} to exist after scaffolding.`);
    }
  });

  await step(
    'speed up the scaffolded monitor for a bounded test cycle, then re-validate',
    () => {
      speedUpMonitorForTesting(monitorPath);
      const result = runCli(['validate', '.claude/monitors']);
      if (!result.stdout.includes('Valid monitors: 1')) {
        throw new Error(
          `Expected "Valid monitors: 1" in validate output, got:\n${result.stdout}`,
        );
      }
    },
  );

  let daemon;
  const daemonLogChunks = [];
  try {
    daemon = await step(
      'start the daemon (explicit socket, no idle reap, fast poll)',
      () => {
        const child = spawn(
          process.execPath,
          [
            launcherEntryPoint,
            'daemon',
            'run',
            '.claude/monitors',
            '--workspace',
            projectDir,
            '--socket',
            socketPath,
            '--reap-after-ms',
            '0',
            '--poll-ms',
            '500',
          ],
          {
            cwd: projectDir,
            env: { ...cliEnv, AGENTMONITORS_DB: dbPath },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        child.stdout.on('data', (chunk) => daemonLogChunks.push(chunk));
        child.stderr.on('data', (chunk) => daemonLogChunks.push(chunk));
        child.on('exit', (code, signal) => {
          daemonLogChunks.push(
            Buffer.from(
              `\n[daemon exited: code=${String(code)} signal=${String(signal)}]\n`,
            ),
          );
        });
        return child;
      },
    );

    await step('wait for the daemon socket to appear', () =>
      waitFor(
        `socket file at ${socketPath}`,
        () => ({
          ok: existsSync(socketPath),
          detail: 'socket file not yet present',
        }),
        { timeoutMs: 15_000, intervalMs: 200 },
      ),
    );

    const hostSessionId = `e2e-fresh-install-hooks-${String(process.pid)}`;
    // `existsSync(socketPath)` above only proves the socket *file* exists,
    // not that the daemon has finished `listen()` and is ready to `accept()`
    // — bind-then-listen is not provably atomic cross-process. This is the
    // FIRST CLI call over the socket, so it gets a short retry; every later
    // socket call in this script runs only after this one already
    // succeeded, so none of them need their own retry.
    const sessionId = await step('open a lead session', async () => {
      const result = await retryOnce('session open', () =>
        runCli([
          'session',
          'open',
          '--host-session-id',
          hostSessionId,
          '--workspace',
          projectDir,
          '--socket',
          socketPath,
          '--format',
          'id',
        ]),
      );
      const id = result.stdout.trim();
      if (id.length === 0) {
        throw new Error(
          `"session open --format id" printed an empty session id.`,
        );
      }
      return id;
    });
    console.log(`AgentMon session id: ${sessionId}`);

    await step(
      'force a deterministic baseline tick via daemon.tick, then touch the watched file',
      async () => {
        // Force a real tick on the already-running daemon through the
        // `daemon.tick` IPC method (docs/specs/002-runtime-delivery.md
        // §10.5) instead of sleeping and hoping the daemon's own --poll-ms
        // interval baselines the file first. Awaiting this call is a hard
        // guarantee the baseline fingerprint has been recorded before the
        // file is mutated below — a fixed sleep instead races the daemon's
        // poll loop and is flaky under a slow CI runner: if the write lands
        // before the daemon's first tick, that write becomes the *baseline*
        // rather than a *change*, no event is ever emitted, and the run
        // times out 20s later with a misleading "no watch-file event yet"
        // detail instead of a clear cause.
        await callDaemonIpc(socketPath, 'daemon.tick', {
          monitorsDir: '.claude/monitors',
          workspacePath: projectDir,
        });
        writeFileSync(watchedFilePath, 'second\n', 'utf-8');
      },
    );

    const eventCreatedAt = Date.now();
    await step(
      'wait for detect + settle: `events list --unread` shows the event (AC1a)',
      () =>
        waitFor(
          'at least one unread event for the session',
          () => {
            const result = runCli([
              'events',
              'list',
              '--session',
              sessionId,
              '--socket',
              socketPath,
              '--unread',
              '--format',
              'json',
            ]);
            const events = JSON.parse(result.stdout);
            if (!Array.isArray(events) || events.length === 0) {
              return {
                ok: false,
                detail: `events list returned: ${result.stdout}`,
              };
            }
            const event = events.find((e) => e.monitorId === 'watch-file');
            if (!event) {
              return {
                ok: false,
                detail: `no watch-file event yet among: ${result.stdout}`,
              };
            }
            return { ok: true, value: event };
          },
          { timeoutMs: 20_000, intervalMs: 1_000 },
        ),
    );

    const hookPayload = JSON.stringify({
      session_id: hostSessionId,
      cwd: projectDir,
      hook_event_name: 'UserPromptSubmit',
    });

    const deliverOutput = await step(
      'wait for the 15s high-urgency claim-time settle window, then confirm `hook deliver` returns non-empty additionalContext for a real UserPromptSubmit payload (AC1b)',
      () =>
        waitFor(
          'hook deliver to return a non-empty hookSpecificOutput.additionalContext',
          () => {
            const result = runLauncher(
              ['hook', 'deliver', '--socket', socketPath],
              {
                input: hookPayload,
                cwd: projectDir,
                env: cliEnv,
              },
            );
            const stdout = result.stdout.trim();
            if (stdout.length === 0) {
              const elapsed = Date.now() - eventCreatedAt;
              return {
                ok: false,
                detail: `empty stdout after ${(elapsed / 1000).toFixed(1)}s since event creation (waiting past the ${(HIGH_URGENCY_SETTLE_MS / 1000).toFixed(0)}s settle window)`,
              };
            }
            return { ok: true, value: stdout };
          },
          { timeoutMs: HIGH_URGENCY_SETTLE_MS + 15_000, intervalMs: 2_000 },
        ),
    );

    await step(
      'assert the hook wire JSON shape and a non-empty additionalContext (docs/specs/006 §5.1)',
      () => {
        const parsed = JSON.parse(deliverOutput);
        if (parsed.continue !== true) {
          throw new Error(
            `Expected continue: true, got: ${JSON.stringify(parsed)}`,
          );
        }
        if (parsed.hookSpecificOutput?.hookEventName !== 'UserPromptSubmit') {
          throw new Error(
            `Expected hookSpecificOutput.hookEventName "UserPromptSubmit", got: ${JSON.stringify(parsed)}`,
          );
        }
        const additionalContext = parsed.hookSpecificOutput?.additionalContext;
        if (
          typeof additionalContext !== 'string' ||
          additionalContext.length === 0
        ) {
          throw new Error(
            `Expected a non-empty string additionalContext, got: ${JSON.stringify(parsed)}`,
          );
        }
        if (!additionalContext.includes('watch-file')) {
          throw new Error(
            `Expected additionalContext to name the firing monitor "watch-file", got: ${additionalContext}`,
          );
        }
        console.log(`Delivered additionalContext:\n${additionalContext}`);
      },
    );

    await step(
      'cross-check: claiming never acknowledges — the event is still unread, now "claimed" (docs/specs/002 §7)',
      () => {
        const result = runCli([
          'events',
          'list',
          '--session',
          sessionId,
          '--socket',
          socketPath,
          '--unread',
          '--format',
          'json',
        ]);
        const events = JSON.parse(result.stdout);
        const event = events.find((e) => e.monitorId === 'watch-file');
        if (!event) {
          throw new Error(
            `Expected the watch-file event to still be unread after hook deliver claimed it, got: ${result.stdout}`,
          );
        }
        if (event.deliveryState !== 'claimed') {
          throw new Error(
            `Expected deliveryState "claimed" after hook deliver, got "${String(event.deliveryState)}"`,
          );
        }
      },
    );
  } catch (error) {
    // Any failure between daemon start and here is only diagnosable from CI
    // logs alone (issue #276 AC2) if the daemon's own captured output is
    // actually printed — the daemonLogPath below is unrecoverable once an
    // ephemeral CI runner's job ends.
    printDaemonLogTail(daemonLogChunks, daemonLogPath);
    throw error;
  } finally {
    if (daemon) {
      try {
        runLauncher(['daemon', 'stop', '--socket', socketPath], {
          cwd: projectDir,
          env: cliEnv,
        });
      } catch (stopError) {
        console.warn(
          `Warning: "daemon stop" failed (best-effort cleanup): ${stopError instanceof Error ? stopError.message : String(stopError)}`,
        );
      }
      if (!daemon.killed) {
        // Belt-and-braces: never leave an orphaned daemon process behind
        // even if graceful "daemon stop" failed.
        daemon.kill('SIGTERM');
      }
      await new Promise((resolve) => {
        if (daemon.exitCode !== null || daemon.signalCode !== null) {
          resolve();
          return;
        }
        daemon.once('exit', () => {
          resolve();
        });
        setTimeout(() => {
          if (daemon.exitCode === null && daemon.signalCode === null) {
            daemon.kill('SIGKILL');
          }
          resolve();
        }, 3_000);
      });
    }
    writeFileSync(
      daemonLogPath,
      Buffer.concat(
        daemonLogChunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))),
      ),
    );
    console.log(`\nDaemon log captured at: ${daemonLogPath}`);
  }

  const overallElapsedMs = Date.now() - overallStart;
  console.log('\n=== Step timings ===');
  for (const timing of stepTimings) {
    console.log(
      `  ${timing.ok ? 'OK  ' : 'FAIL'} ${(timing.elapsedMs / 1000).toFixed(1).padStart(6)}s  ${timing.name}`,
    );
  }
  console.log(
    `\nFresh-environment install-to-first-signal (hooks path) proof completed in ${(overallElapsedMs / 1000).toFixed(1)}s.`,
  );
}

// Only run when invoked directly (`node scripts/test-e2e-fresh-install-hooks.mjs`
// / `pnpm test:e2e-fresh-install-hooks`), never as a side effect of another
// script importing this module. `argv[1]` is resolved to an absolute path
// first: `pathToFileURL` on a relative path resolves against
// `process.cwd()` at call time rather than throwing, so an unresolved
// relative `argv[1]` could silently mismatch `import.meta.url`.
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  try {
    await main();
  } catch (error) {
    console.error(
      `\n✖ FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (error instanceof Error && error.cause instanceof Error) {
      console.error(`  Caused by: ${error.cause.message}`);
    }
    process.exitCode = 1;
  }
}
