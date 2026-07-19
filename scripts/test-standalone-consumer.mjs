#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Project } from 'fixturify-project';
import { packPackage } from './lib/pack-helpers.mjs';
import { PACKAGE_DIRS } from './publish-release-packages.mjs';
import { assertSourceCoverage } from './source-coverage.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const CORE_PACKAGE_NAME = '@agentmonitors/core';

// Every bundled `plugins/source-*` package the smoke test packs, installs,
// and exercises in the standalone consumer project. This list is the thing
// `assertSourceCoverage` validates against `PACKAGE_DIRS` (the authoritative
// publishable-package list in `scripts/publish-release-packages.mjs`): add a
// new bundled source's package here (and give it a smoke assertion below,
// see the command-poll block for the minimal direct-call pattern) whenever
// it's added to `PACKAGE_DIRS`, or `main()` fails loudly naming the gap
// before it does any expensive build/pack work (issue #264).
export const SOURCE_PLUGINS = [
  {
    dir: 'plugins/source-api-poll',
    packageName: '@agentmonitors/source-api-poll',
    sourceName: 'api-poll',
    importName: 'apiPollSource',
  },
  {
    dir: 'plugins/source-file-fingerprint',
    packageName: '@agentmonitors/source-file-fingerprint',
    sourceName: 'file-fingerprint',
    importName: 'fileFingerprintSource',
  },
  {
    dir: 'plugins/source-schedule',
    packageName: '@agentmonitors/source-schedule',
    sourceName: 'schedule',
    importName: 'scheduleSource',
  },
  {
    dir: 'plugins/source-incoming-changes',
    packageName: '@agentmonitors/source-incoming-changes',
    sourceName: 'incoming-changes',
    importName: 'incomingChangesSource',
  },
  {
    dir: 'plugins/source-command-poll',
    packageName: '@agentmonitors/source-command-poll',
    sourceName: 'command-poll',
    importName: 'commandPollSource',
  },
];

const PACKAGE_DEFS = [
  { name: CORE_PACKAGE_NAME, dir: 'libs/core' },
  ...SOURCE_PLUGINS.map(({ packageName, dir }) => ({
    name: packageName,
    dir,
  })),
];

// ---- Generated fragments for the embedded smoke scripts below ----
// Built once from SOURCE_PLUGINS so the import/registration/assertion code
// for each bundled source lives in exactly one place.
const sourceImportLines = SOURCE_PLUGINS.map(
  ({ importName, packageName }) =>
    `import ${importName} from '${packageName}';`,
).join('\n');
const sourceRegisterLines = SOURCE_PLUGINS.map(
  ({ importName }) => `registry.register(${importName});`,
).join('\n');
const sourceTypesArrayLines = SOURCE_PLUGINS.map(
  ({ importName }) => `  ${importName},`,
).join('\n');
const packageNamesLiteral = JSON.stringify(
  [CORE_PACKAGE_NAME, ...SOURCE_PLUGINS.map((plugin) => plugin.packageName)],
  null,
  2,
);
const sourceNamesLiteral = JSON.stringify(
  SOURCE_PLUGINS.map((plugin) => plugin.sourceName).sort(),
);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${result.status ?? 'unknown'}): ${command} ${args.join(' ')}`,
    );
  }
}

const SMOKE_SCRIPT = `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentMonitorRuntime,
  RuntimeStore,
  SourceRegistry,
  createDb,
  generateMonitorSchema,
  parseMonitorFile,
} from '@agentmonitors/core';
${sourceImportLines}

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const packageNames = ${packageNamesLiteral};

for (const packageName of packageNames) {
  const packageJson = JSON.parse(
    readFileSync(
      path.join(projectDir, 'node_modules', ...packageName.split('/'), 'package.json'),
      'utf8',
    ),
  );
  assert.equal(packageJson.name, packageName);
  assert.ok(
    !JSON.stringify(packageJson).includes('workspace:'),
    \`\${packageName} still contains workspace protocol metadata in package.json\`,
  );
}

const registry = new SourceRegistry();
${sourceRegisterLines}
assert.deepEqual(registry.names().sort(), ${sourceNamesLiteral});

const schema = generateMonitorSchema(registry.list());
assert.deepEqual(schema.properties.watch.properties.type.enum.sort(), registry.names().sort());

const workspaceDir = path.join(projectDir, 'workspace');
const monitorsDir = path.join(workspaceDir, '.claude', 'monitors');
const hookStatePath = path.join(workspaceDir, '.agentmonitors', 'hook-state.json');
const dbPath = path.join(workspaceDir, '.agentmonitors', 'runtime.sqlite');
const watchedFilePath = path.join(workspaceDir, 'watched.txt');
mkdirSync(monitorsDir, { recursive: true });
writeFileSync(watchedFilePath, 'first\\n', 'utf8');

let responseBody = JSON.stringify({ version: 1, ok: true });
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(responseBody);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  // Both fixtures below declare \`baseline-strategy: incremental\` explicitly:
  // the default, \`net\` (001 §3.7), collapses each object's multiple
  // observations down to one delivered "newest" event at claim time (002
  // §1.1.7), which would undercount the per-observation event/unread
  // assertions below (each of the 2 ticks touches the same object twice).
  // \`incremental\` restores the original play-by-play semantics this smoke
  // test was written against.
  const fileMonitorDir = path.join(monitorsDir, 'watch-file');
  mkdirSync(fileMonitorDir, { recursive: true });
  writeFileSync(
    path.join(fileMonitorDir, 'MONITOR.md'),
    \`---
name: Watch file
watch:
  type: file-fingerprint
  globs:
    - watched.txt
  cwd: \${workspaceDir}
  interval: 0s
urgency: normal
baseline-strategy: incremental
---
Tell the agent the watched file changed.
\`,
    'utf8',
  );

  const apiMonitorDir = path.join(monitorsDir, 'watch-api');
  mkdirSync(apiMonitorDir, { recursive: true });
  writeFileSync(
    path.join(apiMonitorDir, 'MONITOR.md'),
    \`---
name: Watch api
watch:
  type: api-poll
  url: http://127.0.0.1:\${port}/state
  interval: 0s
  change-detection:
    strategy: json-diff
urgency: normal
baseline-strategy: incremental
---
Tell the agent the local API changed.
\`,
    'utf8',
  );

  const parsedMonitor = parseMonitorFile(path.join(fileMonitorDir, 'MONITOR.md'));
  assert.equal(parsedMonitor.ok, true);

  const runtime = new AgentMonitorRuntime(
    new RuntimeStore(createDb(dbPath)),
    registry,
  );
  const session = runtime.openSession({
    adapter: 'claude-code',
    hostSessionId: 'standalone-consumer-session',
    agentIdentity: 'standalone-consumer-session',
    hookStatePath,
    workspacePath: workspaceDir,
    role: 'lead',
  });

  const firstTick = await runtime.tick(monitorsDir, workspaceDir);
  assert.equal(firstTick.emittedEventIds.length, 0);
  assert.equal(runtime.listEvents({ sessionId: session.id }).length, 0);

  writeFileSync(watchedFilePath, 'second\\n', 'utf8');
  responseBody = JSON.stringify({ version: 2, ok: true });
  const secondTick = await runtime.tick(monitorsDir, workspaceDir);
  assert.equal(secondTick.emittedEventIds.length, 2);

  writeFileSync(watchedFilePath, 'third\\n', 'utf8');
  responseBody = JSON.stringify({ version: 3, ok: true });
  const thirdTick = await runtime.tick(monitorsDir, workspaceDir);
  assert.equal(thirdTick.emittedEventIds.length, 2);

  const unreadEvents = runtime.listEvents({
    sessionId: session.id,
    unreadOnly: true,
    sinceBaseline: true,
  });
  assert.equal(unreadEvents.length, 4);

  const apiEvents = unreadEvents.filter((event) => event.monitorId === 'watch-api');
  const fileEvents = unreadEvents.filter((event) => event.monitorId === 'watch-file');
  assert.equal(apiEvents.length, 2);
  assert.equal(fileEvents.length, 2);
  assert.ok(apiEvents.some((event) => typeof event.snapshotText === 'string'));
  assert.ok(fileEvents.some((event) => typeof event.snapshotText === 'string'));
  assert.ok(apiEvents.some((event) => typeof event.diffText === 'string'));
  assert.ok(fileEvents.some((event) => typeof event.diffText === 'string'));

  const claim = runtime.claimDelivery(session.id, 'turn-interruptible');
  assert.ok(claim);
  assert.equal(claim.urgency, 'normal');
  // 002 §9.2 (issues #438/#434): the coalesced normal-urgency reminder is
  // self-sufficient — it MUST name BOTH runnable steps, the session-scoped
  // discovery command (\`events list --session <id> --unread\`) AND the
  // acknowledge command (\`events ack --session <id>\`), each with the real
  // session id interpolated. These are transcribed straight from the spec
  // wording (mirroring the \`reminderMessage\` fixture in
  // libs/core/src/runtime/service.test.ts) rather than a loose substring
  // check, so a regression that drops either command — e.g. keeping only the
  // ack line — fails here, not just in the focused unit tests.
  const expectedListCommand = \`agentmonitors events list --session \${session.id} --unread\`;
  const expectedAckCommand = \`agentmonitors events ack --session \${session.id}\`;
  assert.ok(
    claim.message.includes(expectedListCommand),
    \`expected reminder to include the discovery command "\${expectedListCommand}", got: \${claim.message}\`,
  );
  assert.ok(
    claim.message.includes(expectedAckCommand),
    \`expected reminder to include the ack command "\${expectedAckCommand}", got: \${claim.message}\`,
  );
  assert.ok(
    !claim.message.toLowerCase().includes('inbox'),
    \`expected reminder not to reference the legacy inbox, got: \${claim.message}\`,
  );
  assert.ok(
    !claim.message.includes('AgentMon'),
    \`expected reminder to be unattributed (no "AgentMon" prefix), got: \${claim.message}\`,
  );

  const hookState = JSON.parse(readFileSync(hookStatePath, 'utf8'));
  assert.equal(hookState.sessionId, session.id);
  assert.equal(hookState.unread.total, 4);

  runtime.acknowledgeSession(session.id);
  assert.equal(
    runtime.listEvents({ sessionId: session.id, unreadOnly: true }).length,
    0,
  );

  const scheduled = await scheduleSource.observe(
    {
      cron: '*/5 * * * *',
      timezone: 'UTC',
      label: 'Five minute timer',
    },
    { now: new Date('2026-03-21T18:00:00.000Z') },
  );
  assert.equal(scheduled.observations.length, 1);
  assert.equal(scheduled.observations[0]?.title, 'Five minute timer');

  // ---- command-poll source: direct-call smoke ----
  // Exercised directly (like schedule above) rather than via a full runtime
  // tick: command-poll's behavior is fully deterministic from \`observe()\`
  // inputs alone (003 §11), so a tick-based fixture would add scaffolding
  // without adding coverage. The first call establishes the baseline (no
  // observations); the second call, with the same argv but a different
  // \`env\` value threaded into stdout, must emit exactly one
  // output-changed event (003 §11.3/§11.4, text-diff strategy).
  const commandScope = {
    command: ['node', '-e', 'console.log(process.env.SMOKE_VALUE || "")'],
  };
  const commandBaseline = await commandPollSource.observe(
    { ...commandScope, env: { SMOKE_VALUE: 'one' } },
    { now: new Date('2026-03-21T18:00:00.000Z') },
  );
  assert.equal(commandBaseline.observations.length, 0);
  assert.equal(commandBaseline.nextState.baselined, true);

  const commandChanged = await commandPollSource.observe(
    { ...commandScope, env: { SMOKE_VALUE: 'two' } },
    {
      now: new Date('2026-03-21T18:05:00.000Z'),
      previousState: commandBaseline.nextState,
    },
  );
  assert.equal(commandChanged.observations.length, 1);
  assert.equal(
    commandChanged.observations[0]?.title,
    'Command output changed: ' + commandScope.command.join(' '),
  );

  // ---- incoming-changes source: git-backed smoke ----
  // The incoming-changes source shells out to git, so exercise it against a
  // real temp repo: create a branch with an initial commit, baseline it, then
  // advance it with a second commit touching the tracked path and assert the
  // next tick emits exactly one event for the changed file (spec 003 §6.2).
  const gitRepoDir = path.join(projectDir, 'incoming-repo');
  const trackedDir = path.join(gitRepoDir, 'tracked');
  const trackedFile = path.join(trackedDir, 'file.txt');
  mkdirSync(trackedDir, { recursive: true });

  // Keep the success path quiet, but surface git's stderr on failure so a
  // pre-publish break (missing git, config/commit failure) is diagnosable.
  const git = (args) => {
    try {
      return execFileSync('git', args, {
        cwd: gitRepoDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (typeof error.stderr === 'string' && error.stderr.length > 0) {
        process.stderr.write(error.stderr);
      }
      throw error;
    }
  };

  git(['init']);
  git(['config', 'user.email', 'smoke@example.com']);
  git(['config', 'user.name', 'Standalone Smoke']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(trackedFile, 'one\\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-m', 'first commit']);
  // Rename whatever the default branch is to a deterministic name.
  git(['branch', '-m', 'work']);

  const incomingMonitorsDir = path.join(projectDir, 'incoming-monitors');
  const incomingMonitorDir = path.join(incomingMonitorsDir, 'watch-incoming');
  mkdirSync(incomingMonitorDir, { recursive: true });
  writeFileSync(
    path.join(incomingMonitorDir, 'MONITOR.md'),
    \`---
name: Watch incoming
watch:
  type: incoming-changes
  paths:
    - tracked/file.txt
  branch: work
  cwd: \${gitRepoDir}
  interval: 0s
urgency: normal
---
Tell the agent an incoming change landed.
\`,
    'utf8',
  );

  // A workspace with no open session: incoming-changes events materialize but
  // project into nothing, so the main-session assertions above stay intact.
  const incomingWorkspaceDir = path.join(projectDir, 'incoming-workspace');
  mkdirSync(incomingWorkspaceDir, { recursive: true });

  // Baseline run: records the current SHA and emits nothing (spec 003 §6.2).
  const incomingBaselineTick = await runtime.tick(
    incomingMonitorsDir,
    incomingWorkspaceDir,
  );
  assert.equal(incomingBaselineTick.emittedEventIds.length, 0);

  // Advance the branch with a commit touching the tracked path.
  writeFileSync(trackedFile, 'two\\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-m', 'second commit']);

  const incomingAdvanceTick = await runtime.tick(
    incomingMonitorsDir,
    incomingWorkspaceDir,
  );
  assert.equal(incomingAdvanceTick.emittedEventIds.length, 1);

  const incomingEvents = runtime.listEvents({ monitorId: 'watch-incoming' });
  assert.equal(incomingEvents.length, 1);
  const incomingEvent = incomingEvents[0];
  assert.ok(incomingEvent);
  // spec 002 §5.4: the event title is the monitor's authored name
  assert.equal(incomingEvent.title, 'Watch incoming');
  // spec 003 §6.2: the source's own text — "Incoming change: <path>
  // (<changeKind>)" — is carried by summary
  assert.equal(
    incomingEvent.summary,
    'Incoming change: tracked/file.txt (modified)',
  );
  // spec 003 §2.3 + §6.2: runtime copies changeKind into queryScope.changeKind
  assert.equal(incomingEvent.queryScope.changeKind, 'modified');
  // spec 003 §6.2: objectKey is the file path as reported by git
  assert.equal(incomingEvent.objectKey, 'tracked/file.txt');
  // spec 003 §6.2: snapshotText is the new file content for modified files
  assert.equal(incomingEvent.snapshotText, 'two\\n');
  // spec 003 §6.2: payload is { path, status, fromRef, toRef }
  assert.equal(incomingEvent.payload.path, 'tracked/file.txt');
  assert.equal(incomingEvent.payload.status, 'M');

  console.log(JSON.stringify({
    projectDir,
    workspaceDir,
    installedPackages: packageNames,
    emittedEventIds: [
      ...secondTick.emittedEventIds,
      ...thirdTick.emittedEventIds,
    ],
  }, null, 2));
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
`;

const SMOKE_TYPES_SCRIPT = `import type { ObservationSource, Urgency } from '@agentmonitors/core';
import {
  AgentMonitorRuntime,
  RuntimeStore,
  SourceRegistry,
  createDb,
  generateMonitorSchema,
  parseMonitor,
} from '@agentmonitors/core';
${sourceImportLines}

const sources: ObservationSource[] = [
${sourceTypesArrayLines}
];

const registry = new SourceRegistry();
for (const source of sources) {
  registry.register(source);
}

const schema = generateMonitorSchema(registry.list());
const parsed = parseMonitor(
  \`---
name: Typed monitor
watch:
  type: file-fingerprint
  globs:
    - package.json
urgency: normal
---
Type smoke
\`,
  '/tmp/typed-monitor/MONITOR.md',
);

if (!parsed.ok) {
  throw new Error(parsed.error);
}

const urgency: Urgency = parsed.monitor.frontmatter.urgency;
const runtime = new AgentMonitorRuntime(
  new RuntimeStore(createDb(':memory:')),
  registry,
);

void schema;
void runtime;
void urgency;
`;

async function createStandaloneProject(projectDir) {
  const project = new Project({
    files: {
      'package.json': `${JSON.stringify(
        {
          name: 'agentmonitors-standalone-consumer',
          private: true,
          type: 'module',
          scripts: {
            check: 'tsc --noEmit',
            smoke: 'node smoke.mjs',
          },
        },
        null,
        2,
      )}\n`,
      'tsconfig.json': `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noEmit: true,
            types: ['node'],
          },
          include: ['smoke-types.ts'],
        },
        null,
        2,
      )}\n`,
      'smoke.mjs': SMOKE_SCRIPT,
      'smoke-types.ts': SMOKE_TYPES_SCRIPT,
    },
  });
  project.baseDir = projectDir;
  await project.write();
}

async function main() {
  // Fail loudly, before any expensive build/pack/install work, if a
  // publishable `plugins/source-*` package (per PACKAGE_DIRS) has no
  // corresponding entry in SOURCE_PLUGINS above (issue #264).
  assertSourceCoverage(
    PACKAGE_DIRS,
    SOURCE_PLUGINS.map((plugin) => plugin.sourceName),
  );

  console.log('Building published packages...');
  run(PNPM_BIN, ['build'], REPO_ROOT);

  const projectDir = mkdtempSync(
    path.join(os.tmpdir(), 'agentmonitors-standalone-consumer-'),
  );
  const packDir = path.join(projectDir, 'packed');
  mkdirSync(packDir, { recursive: true });

  console.log(`Standalone consumer project: ${projectDir}`);
  console.log('Packing packages...');
  const tarballs = PACKAGE_DEFS.map((pkg) =>
    packPackage(path.join(REPO_ROOT, pkg.dir), packDir),
  );

  await createStandaloneProject(projectDir);

  console.log('Installing packed packages into standalone temp project...');
  run(
    NPM_BIN,
    ['install', '--save-dev', 'typescript@5.9.3', '@types/node@22'],
    projectDir,
  );
  run(NPM_BIN, ['install', ...tarballs], projectDir);

  console.log('Running standalone TypeScript check...');
  run(NPM_BIN, ['run', 'check'], projectDir);

  console.log('Running standalone runtime smoke...');
  run(NPM_BIN, ['run', 'smoke'], projectDir);

  console.log(
    `Standalone consumer smoke completed successfully in ${projectDir}`,
  );
}

// Only run when invoked directly (`node scripts/test-standalone-consumer.mjs`
// / `pnpm test:standalone-consumer`), never as a side effect of another
// script (e.g. the coverage-drift unit test) importing SOURCE_PLUGINS.
// `argv[1]` is resolved to an absolute path first: `pathToFileURL` on a
// relative path resolves against `process.cwd()` at call time rather than
// throwing, so an unresolved relative `argv[1]` could silently mismatch
// `import.meta.url`.
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
  await main();
}
