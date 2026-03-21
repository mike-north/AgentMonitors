#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    process.stderr.write(result.stderr);
    throw new Error(
      `Command failed (${result.status ?? 'unknown'}): ${command} ${args.join(' ')}`,
    );
  }
  return (result.stdout ?? '').trim();
}

function writeText(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function createPackageJson(projectDir) {
  writeJson(path.join(projectDir, 'package.json'), {
    name: 'agentmonitors-standalone-consumer',
    private: true,
    type: 'module',
    scripts: {
      check: 'tsc --noEmit',
      smoke: 'node smoke.mjs',
    },
  });
}

function createTsConfig(projectDir) {
  writeJson(path.join(projectDir, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      types: ['node'],
    },
    include: ['smoke-types.ts'],
  });
}

function createSmokeFiles(projectDir) {
  writeText(
    path.join(projectDir, 'smoke.mjs'),
    `import assert from 'node:assert/strict';
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

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const packageNames = [
  '@mike-north/core',
  '@mike-north/source-api-poll',
  '@mike-north/source-file-fingerprint',
  '@mike-north/source-schedule',
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
    !JSON.stringify(packageJson).includes('workspace:*'),
    \`\${packageName} still contains workspace protocol metadata\`,
  );
}

const registry = new SourceRegistry();
registry.register(apiPollSource);
registry.register(fileFingerprintSource);
registry.register(scheduleSource);
assert.deepEqual(registry.names().sort(), [
  'api-poll',
  'file-fingerprint',
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
event-kind: mutation
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
event-kind: notification
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
`,
  );

  writeText(
    path.join(projectDir, 'smoke-types.ts'),
    `import type { ObservationSource, Urgency } from '@mike-north/core';
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

const sources: ObservationSource[] = [
  apiPollSource,
  fileFingerprintSource,
  scheduleSource,
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
event-kind: mutation
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
`,
  );
}

function main() {
  console.log('Building published packages...');
  for (const pkg of PACKAGE_DEFS) {
    run(PNPM_BIN, ['--filter', pkg.name, 'build'], REPO_ROOT);
  }

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

  createPackageJson(projectDir);
  createTsConfig(projectDir);
  createSmokeFiles(projectDir);

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

main();
