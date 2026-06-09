#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from 'fixturify-project';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PACKAGE_DEFS = [
  { name: '@mike-north/core', dir: 'libs/core' },
  { name: '@mike-north/source-api-poll', dir: 'plugins/source-api-poll' },
  {
    name: '@mike-north/source-file-fingerprint',
    dir: 'plugins/source-file-fingerprint',
  },
  { name: '@mike-north/source-schedule', dir: 'plugins/source-schedule' },
  {
    name: '@mike-north/source-incoming-changes',
    dir: 'plugins/source-incoming-changes',
  },
];

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

function runCapture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    if (typeof result.stderr === 'string' && result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    const errorMessageParts = [
      `Command failed (${result.status ?? 'unknown'}): ${command} ${args.join(' ')}`,
    ];
    if (result.error?.message) {
      errorMessageParts.push(`Spawn error: ${result.error.message}`);
    }
    throw new Error(errorMessageParts.join('\n'));
  }
  return (result.stdout ?? '').trim();
}

function packPackage(packageDir, packDir) {
  const before = new Set(readdirSync(packDir));
  const output = runCapture(
    PNPM_BIN,
    ['pack', '--pack-destination', packDir],
    packageDir,
  );
  const after = readdirSync(packDir);
  const created = after.find(
    (entry) => !before.has(entry) && entry.endsWith('.tgz'),
  );

  if (!created) {
    throw new Error(
      `Could not determine packed tarball for ${packageDir}. pnpm output: ${output}`,
    );
  }

  return path.join(packDir, created);
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
} from '@mike-north/core';
import apiPollSource from '@mike-north/source-api-poll';
import fileFingerprintSource from '@mike-north/source-file-fingerprint';
import scheduleSource from '@mike-north/source-schedule';
import incomingChangesSource from '@mike-north/source-incoming-changes';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const packageNames = [
  '@mike-north/core',
  '@mike-north/source-api-poll',
  '@mike-north/source-file-fingerprint',
  '@mike-north/source-schedule',
  '@mike-north/source-incoming-changes',
];

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
registry.register(apiPollSource);
registry.register(fileFingerprintSource);
registry.register(scheduleSource);
registry.register(incomingChangesSource);
assert.deepEqual(registry.names().sort(), [
  'api-poll',
  'file-fingerprint',
  'incoming-changes',
  'schedule',
]);

const schema = generateMonitorSchema(registry.list());
assert.deepEqual(schema.properties.source.enum.sort(), registry.names().sort());

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

  const fileMonitorDir = path.join(monitorsDir, 'watch-file');
  mkdirSync(fileMonitorDir, { recursive: true });
  writeFileSync(
    path.join(fileMonitorDir, 'MONITOR.md'),
    \`---
name: Watch file
source: file-fingerprint
urgency: normal
scope:
  globs:
    - watched.txt
  cwd: \${workspaceDir}
  interval: 0s
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
source: api-poll
urgency: normal
scope:
  url: http://127.0.0.1:\${port}/state
  interval: 0s
  change-detection:
    strategy: json-diff
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
  assert.equal(claim.message, 'AgentMon messages are available. Read the inbox.');

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
source: incoming-changes
urgency: normal
scope:
  paths:
    - tracked/file.txt
  branch: work
  cwd: \${gitRepoDir}
  interval: 0s
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
  // spec 003 §6.2: title is "Incoming change: <path> (<changeKind>)"
  assert.equal(
    incomingEvent.title,
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

const SMOKE_TYPES_SCRIPT = `import type { ObservationSource, Urgency } from '@mike-north/core';
import {
  AgentMonitorRuntime,
  RuntimeStore,
  SourceRegistry,
  createDb,
  generateMonitorSchema,
  parseMonitor,
} from '@mike-north/core';
import apiPollSource from '@mike-north/source-api-poll';
import fileFingerprintSource from '@mike-north/source-file-fingerprint';
import scheduleSource from '@mike-north/source-schedule';
import incomingChangesSource from '@mike-north/source-incoming-changes';

const sources: ObservationSource[] = [
  apiPollSource,
  fileFingerprintSource,
  scheduleSource,
  incomingChangesSource,
];

const registry = new SourceRegistry();
for (const source of sources) {
  registry.register(source);
}

const schema = generateMonitorSchema(registry.list());
const parsed = parseMonitor(
  \`---
name: Typed monitor
source: file-fingerprint
urgency: normal
scope:
  globs:
    - package.json
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

await main();
