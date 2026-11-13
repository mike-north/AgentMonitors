/**
 * The suite boundary must isolate inherited host paths and detect accidental
 * writes to an installation. Nested suites use a fake installation, so even
 * the negative controls cannot damage a developer's files.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { realUserPaths } from './test-isolation/paths.mjs';
import {
  allGuardedVitestConfigPaths,
  importVitestConfig,
} from './vitest-pass-with-no-tests.mjs';

const repo = resolve(import.meta.dirname, '..');

/** Private workspace packages also need defaults, even outside the publisher inventory. */
function isolationConfigPaths(): string[] {
  const workspace: { packages: string[] } = parse(
    readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8'),
  );
  const configs = workspace.packages.flatMap((pattern) =>
    globSync(`${pattern}/package.json`, { cwd: repo }).flatMap((file) => {
      const manifest = JSON.parse(readFileSync(join(repo, file), 'utf8'));
      const script = manifest.scripts?.test;
      if (typeof script !== 'string' || !script.includes('vitest')) {
        return [];
      }
      if (script !== 'vitest run') {
        throw new Error(
          `Audit the selected Vitest config for ${file}: ${script}`,
        );
      }
      return [join(dirname(file), 'vitest.config.ts')];
    }),
  );
  return [...new Set([...allGuardedVitestConfigPaths(), ...configs])];
}

/** Run the real configured boundary with only owned directories as host paths. */
async function runFixture(
  body: string,
  linked = false,
  options: {
    readonly foreign?: boolean;
    readonly unavailable?: true | 'lsof';
    readonly predecessor?: boolean;
    readonly runtime?: boolean;
    readonly foreignRuntime?: 'churn' | 'leave';
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'isolation-proof-'));
  const home = join(dir, 'real-home');
  const installation = join(home, '.local/share/agentmonitors');
  const receipt = join(dir, 'receipt.json');
  const summaryPath = join(dir, 'summary.json');
  const trigger = join(dir, 'foreign-trigger');
  const written = join(dir, 'foreign-written');
  const runtimeBase = join(dir, 'rt');
  const runtime = join(
    runtimeBase,
    `agentmonitors-${String(process.getuid?.() ?? 0)}`,
  );
  if (options.runtime) {
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, 'probe.sock'), 'fixture');
  }
  if (options.unavailable === 'lsof') {
    mkdirSync(join(dir, 'no-tools'));
    symlinkSync('/bin/ps', join(dir, 'no-tools/ps'));
  }
  if (linked) {
    const target = join(dir, 'installation-target');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(home, '.local/share'), { recursive: true });
    symlinkSync(target, installation, 'dir');
  } else {
    mkdirSync(installation, { recursive: true });
  }
  writeFileSync(join(installation, 'existing'), 'original');
  writeFileSync(join(installation, 'unheld'), 'original');
  // Whole-second mtime survives the Date/utimes round trip exactly, so the
  // same-size edit's rejection must rely on the small-file content hash.
  utimesSync(join(installation, 'existing'), 946_684_800, 946_684_800);
  const config = join(dir, 'vitest.config.mts');
  writeFileSync(
    config,
    `import base from ${JSON.stringify(pathToFileURL(join(repo, 'scripts/vitest.config.ts')).href)};
export default {...base, root: ${JSON.stringify(dir)}, test: {...base.test, pool: 'threads', maxWorkers: 1, include: ['fixture.test.ts']}};`,
  );
  writeFileSync(
    join(dir, 'fixture.test.ts'),
    `import {it,expect,beforeAll,afterEach} from ${JSON.stringify(pathToFileURL(join(repo, 'node_modules/vitest/dist/index.js')).href)};
import {writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const receipt=${JSON.stringify(receipt)};
const installation=${JSON.stringify(installation)};
const trigger=${JSON.stringify(trigger)};
const written=${JSON.stringify(written)};
const runtimeBase=${JSON.stringify(runtimeBase)};
const runtime=${JSON.stringify(runtime)};
${body}`,
  );
  // This leaf is a sibling of the fixture coordinator, never its descendant.
  // IPC disconnect and spawn's hard bound stop only this owned child; it cannot
  // spawn descendants and its exit is awaited before removing its files.
  const foreign = options.foreign
    ? spawn(
        process.execPath,
        [
          '-e',
          `
const fs=require('node:fs');
const fd=fs.openSync(${JSON.stringify(join(installation, 'existing'))},'r+');
let pending=false;
const runtimeFile=${JSON.stringify(runtime)}+'/outside.sock';
// Wait for the peer's own native notification before deleting the entry. This
// makes observation part of the handshake, not a guess about FSEvents latency.
const runtimeWatcher=${JSON.stringify(options.foreignRuntime)}==='churn'?fs.watch(${JSON.stringify(runtime)},()=>{
 if(pending&&fs.existsSync(runtimeFile)){pending=false;runtimeWatcher.close();fs.unlinkSync(runtimeFile);fs.writeFileSync(${JSON.stringify(written)},'done');}
}):undefined;
process.once('disconnect',()=>{runtimeWatcher?.close();fs.closeSync(fd);process.exit(0);});
setInterval(()=>{
  if(fs.existsSync(${JSON.stringify(trigger)})&&!fs.existsSync(${JSON.stringify(written)})&&!pending){
    if(${JSON.stringify(options.foreignRuntime ?? 'file')}==='file'){fs.writeSync(fd,'external');fs.fsyncSync(fd);}
    else {pending=${JSON.stringify(options.foreignRuntime)}==='churn';fs.writeFileSync(runtimeFile,'peer');}
    if(!pending)fs.writeFileSync(${JSON.stringify(written)},'done');
  }
},20);
process.send('ready');`,
        ],
        {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          timeout: 20_000,
          killSignal: 'SIGKILL',
        },
      )
    : undefined;
  const stopped = foreign
    ? new Promise<void>((resolve, reject) => {
        foreign.once('exit', () => resolve());
        foreign.once('error', reject);
      })
    : Promise.resolve();
  try {
    if (foreign) {
      await new Promise<void>((resolve, reject) => {
        foreign.once('message', () => resolve());
        foreign.once('error', reject);
        foreign.once('exit', () =>
          reject(new Error('Foreign fixture exited before readiness')),
        );
      });
      // ps exposes second-resolution start identity. Age past that full second
      // before launching the coordinator, rather than guessing at its birth order.
      await delay(1_100);
      if (options.predecessor) {
        // The peer still holds the unlinked inode. macOS lsof reports its old
        // pathname; the replacement must remain unheld for guard purposes.
        unlinkSync(join(installation, 'existing'));
        writeFileSync(join(installation, 'existing'), 'original');
      }
    }
    // A threads-only Vitest fixture owns no detached processes. Node's
    // synchronous deadline bounds its one process and all worker threads;
    // the environment probe below is also synchronous and separately bounded.
    const result = spawnSync(
      process.execPath,
      [
        join(repo, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        config,
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${summaryPath}`,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          XDG_DATA_HOME: join(dir, 'real-data'),
          XDG_CONFIG_HOME: join(dir, 'real-config'),
          XDG_STATE_HOME: join(dir, 'real-state'),
          XDG_CACHE_HOME: join(dir, 'real-cache'),
          XDG_RUNTIME_DIR: join(dir, 'real-runtime'),
          AGENTMONITORS_DB: join(installation, 'existing'),
          AGENTMONITORS_SOCKET: options.runtime
            ? runtime
            : join(dir, 'real.sock'),
          AGENTMONITORS_TEST_EXTRA_RUNTIME_BASE: options.runtime
            ? runtimeBase
            : undefined,
          ...(options.unavailable ? { PATH: join(dir, 'no-tools') } : {}),
        },
        timeout: 15_000,
      },
    );
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    return {
      ...result,
      installation,
      foreignPid: foreign?.pid,
      runtime,
      // Runner metrics prove a poison case passed before teardown rejected its mutation.
      testSummary: existsSync(summaryPath)
        ? JSON.parse(readFileSync(summaryPath, 'utf8'))
        : undefined,
      receipt: existsSync(receipt)
        ? JSON.parse(readFileSync(receipt, 'utf8'))
        : undefined,
    };
  } finally {
    if (foreign?.connected) {
      foreign.disconnect();
    }
    await stopped;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A real peer writer must be visible without being blamed on the fixture. */
const foreignWrite = `it('foreign write',async()=>{
  writeFileSync(trigger,'go');
  const deadline=Date.now()+2000;
  while(!existsSync(written)&&Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
  expect(existsSync(written)).toBe(true);
});`;

it('reports a pre-run foreign writer without failing the suite', async () => {
  const result = await runFixture(foreignWrite, false, { foreign: true });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout + result.stderr).toContain('Foreign process writes');
  // Preserve the actual nested PID/command/file diagnostic in the green receipt.
  console.info(
    'Fixture attribution receipt:',
    (result.stdout + result.stderr)
      .split('\n')
      .find((line) => line.startsWith('Foreign process writes:')),
  );
  expect(result.stdout + result.stderr).toContain(`PID ${result.foreignPid}`);
  expect(result.stdout + result.stderr).toContain(process.execPath);
  expect(result.stdout + result.stderr).toContain(
    result.installation + '/existing',
  );
}, 20_000);

it('rejects new workspace entries beside a foreign-held file', async () => {
  const result = await runFixture(
    `import {mkdirSync} from 'node:fs';
${foreignWrite}
it('poison',()=>{mkdirSync(installation+'/workspaces/new',{recursive:true});writeFileSync(installation+'/workspaces/new/inbox.db','poison');});`,
    false,
    { foreign: true },
  );
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('Real user paths changed');
  expect(result.stdout + result.stderr).toContain('workspaces/new/inbox.db');
  expect(result.testSummary.numPassedTests).toBe(2);
}, 20_000);

it('rejects an unheld edit beside a foreign-held file', async () => {
  const result = await runFixture(
    `${foreignWrite}
it('poison',()=>{writeFileSync(installation+'/unheld','poison');});`,
    false,
    { foreign: true },
  );
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('unheld');
}, 20_000);

it.each([true, 'lsof'] as const)(
  'keeps the guard strict when process inspection is unavailable (%s)',
  async (unavailable) => {
    const result = await runFixture(
      `it('poison',()=>writeFileSync(installation+'/existing','modified'));`,
      false,
      { unavailable },
    );
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'Process inspection unavailable',
    );
    expect(result.stdout + result.stderr).toContain('existing');
  },
  20_000,
);

it('fails the suite when a new file appears in the real data root', async () => {
  const result = await runFixture(
    `it('poison',()=>{writeFileSync(installation+'/new-file','unexpected');});`,
  );
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('Real user paths changed');
  expect(result.stdout + result.stderr).toContain('new-file');
}, 20_000);

it('detects same-size content changes even with the original mtime restored', async () => {
  const result = await runFixture(`import {statSync,utimesSync} from 'node:fs';
it('poison',()=>{const file=installation+'/existing'; const stat=statSync(file);const ns=statSync(file,{bigint:true}).mtimeNs;writeFileSync(file,'modified');utimesSync(file,stat.atime,stat.mtime);expect(statSync(file,{bigint:true}).mtimeNs).toBe(ns);});`);
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('Real user paths changed');
  expect(result.stdout + result.stderr).toContain('existing');
  expect(result.testSummary.numPassedTests, result.stdout + result.stderr).toBe(
    1,
  );
}, 20_000);

for (const outcome of ['pass', 'fail', 'timeout']) {
  it(`isolates inherited paths and children, and cleans up after ${outcome}`, async () => {
    // Positive/failure probes retain Vitest's normal case budget around a
    // separately bounded Node child; only the deliberate timeout case is short.
    const result = await runFixture(`it('case',async()=>{
const keys=['HOME','XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR','TMPDIR'];
const env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const child=spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify(process.env))'],{encoding:'utf8',timeout:3000});
writeFileSync(receipt,JSON.stringify({env,child:JSON.parse(child.stdout)}));
${outcome === 'fail' ? 'expect(1).toBe(2);' : outcome === 'timeout' ? 'await new Promise(()=>{});' : "expect(process.env.AGENTMONITORS_DB??'').not.toContain(installation);expect(process.env.AGENTMONITORS_SOCKET).toBeUndefined();"}
},${outcome === 'timeout' ? 50 : 5_000});`);
    if (outcome === 'pass') {
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } else {
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
    }
    expect(result.stdout + result.stderr).not.toContain(
      'Real user paths changed',
    );
    for (const [key, value] of Object.entries(result.receipt.env)) {
      expect(value).not.toContain('real-');
      expect(result.receipt.child[key]).toBe(value);
      expect(existsSync(String(value)), `leaked ${key}: ${String(value)}`).toBe(
        false,
      );
    }
  }, 20_000);
}

it.each(isolationConfigPaths())(
  '%s enables the shared isolation boundary',
  async (config) => {
    const resolved = await importVitestConfig(repo, config);
    expect(resolved.test.globalSetup).toContain(
      join(repo, 'scripts/test-isolation/global-setup.mjs'),
    );
    expect(resolved.test.setupFiles).toContain(
      join(repo, 'scripts/test-isolation/setup.mjs'),
    );
  },
);

for (const location of [
  'real-data',
  'real-config',
  'real-state',
  'real-cache',
  'real-runtime',
]) {
  it(`guards an initially absent ${location} installation`, async () => {
    const result = await runFixture(`import {mkdirSync} from 'node:fs';
it('poison',()=>{const dir=${JSON.stringify(location)};const target=installation.split('/real-home/')[0]+'/'+dir+'/agentmonitors';mkdirSync(target,{recursive:true});writeFileSync(target+'/new-file','unexpected');});`);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('Real user paths changed');
    expect(result.stdout + result.stderr).toContain(
      `${location}/agentmonitors`,
    );
  }, 20_000);
}

it('cleans file-scoped roots when beforeAll fails', async () => {
  const result = await runFixture(
    `beforeAll(()=>{writeFileSync(receipt,JSON.stringify({root:process.env.HOME}));throw new Error('setup failed');});it('unreached',()=>{});`,
  );
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('setup failed');
  expect(existsSync(result.receipt.root)).toBe(false);
}, 20_000);

for (const outcome of ['pass', 'throw', 'exit']) {
  it(`isolates standalone checks and cleans up on ${outcome}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'standalone-isolation-'));
    const receipt = join(dir, 'receipt.json');
    try {
      const script = `import {withIsolatedTestEnvironment} from ${JSON.stringify(pathToFileURL(join(repo, 'scripts/test-isolation/boundary.mjs')).href)};
import {writeFileSync} from 'node:fs';
await withIsolatedTestEnvironment(async()=>{writeFileSync(${JSON.stringify(receipt)},JSON.stringify({root:process.env.HOME}));${outcome === 'throw' ? "throw new Error('intentional failure');" : outcome === 'exit' ? 'process.exit(0);' : ''}});`;
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          encoding: 'utf8',
          env: process.env,
          timeout: 5_000,
        },
      );
      expect(result.error, result.stderr).toBeUndefined();
      if (outcome === 'throw') {
        expect(result.status, result.stderr).not.toBe(0);
      } else {
        expect(result.status, result.stderr).toBe(0);
      }
      const { root } = JSON.parse(readFileSync(receipt, 'utf8'));
      expect(root).not.toBe(process.env.HOME);
      expect(existsSync(root)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

it('invalidates cached package tests when the shared boundary changes', () => {
  const config = JSON.parse(readFileSync(join(repo, 'nx.json'), 'utf8'));
  expect(config.namedInputs.testIsolation).toContain(
    '{workspaceRoot}/scripts/test-isolation/**/*',
  );
  for (const target of ['test', 'test:serial']) {
    expect(config.targetDefaults[target].inputs).toContain('testIsolation');
  }
});

it.skipIf(process.platform === 'win32')(
  'guards an installation whose data root is a symlink',
  async () => {
    const result = await runFixture(
      `it('poison',()=>{writeFileSync(installation+'/new-file','unexpected');});`,
      true,
    );
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('Real user paths changed');
    expect(result.stdout + result.stderr).toContain('new-file');
  },
  20_000,
);

for (const outcome of ['fail', 'timeout']) {
  it(`removes ${outcome} case data before the next case starts`, async () => {
    const result = await runFixture(`let previous;
it('first',async()=>{previous=process.env.HOME;writeFileSync(previous+'/owned-file','case data');${outcome === 'fail' ? 'expect(1).toBe(2);' : 'await new Promise(()=>{});'}},50);
it('next',()=>{const cleaned=!existsSync(previous);writeFileSync(receipt,JSON.stringify({cleaned,current:process.env.HOME,previous}));expect(cleaned).toBe(true);expect(process.env.HOME).not.toBe(previous);});`);
    expect(result.status).not.toBe(0);
    expect(result.receipt.cleaned, result.stdout + result.stderr).toBe(true);
    expect(result.receipt.current).not.toBe(result.receipt.previous);
  }, 20_000);
}

it('retains beforeAll fixtures across cases, then removes their file root', async () => {
  const result = await runFixture(`const fileRoot=process.env.HOME;
beforeAll(()=>writeFileSync(fileRoot+'/shared-fixture','fixture'));
for(const name of ['first','second'])it(name,()=>{expect(existsSync(fileRoot+'/shared-fixture')).toBe(true);writeFileSync(receipt,JSON.stringify({fileRoot,caseRoot:process.env.HOME}));});`);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.receipt.fileRoot).not.toBe(result.receipt.caseRoot);
  expect(existsSync(result.receipt.fileRoot)).toBe(false);
}, 20_000);

it('does not let an explicit process exit bypass the installation guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exit-guard-'));
  const installation = join(dir, '.local/share/agentmonitors');
  const receipt = join(dir, 'receipt.json');
  mkdirSync(installation, { recursive: true });
  try {
    const script = `import {withIsolatedTestEnvironment} from ${JSON.stringify(pathToFileURL(join(repo, 'scripts/test-isolation/boundary.mjs')).href)};
import {writeFileSync} from 'node:fs';
await withIsolatedTestEnvironment(async()=>{writeFileSync(${JSON.stringify(receipt)},process.env.HOME);writeFileSync(${JSON.stringify(join(installation, 'poison'))},'unexpected');process.exit(0);});`;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        env: { ...process.env, HOME: dir, USERPROFILE: dir },
        encoding: 'utf8',
        timeout: 5_000,
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('Real user paths changed');
    expect(existsSync(readFileSync(receipt, 'utf8'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('shares only an owned tool cache across cases and removes it with the run', async () => {
  const result = await runFixture(`let toolCache;
it('first',()=>{toolCache=process.env.COREPACK_HOME;expect(toolCache).toBeTruthy();writeFileSync(toolCache+'/tool-fixture','cached');});
it('next',()=>{expect(process.env.COREPACK_HOME).toBe(toolCache);const retained=existsSync(toolCache+'/tool-fixture');writeFileSync(receipt,JSON.stringify({toolCache,retained}));expect(retained).toBe(true);});`);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.receipt.retained).toBe(true);
  expect(existsSync(result.receipt.toolCache)).toBe(false);
}, 20_000);

it('keeps native temp resolution isolated after a test replaces process.env', async () => {
  const result = await runFixture(`import {tmpdir} from 'node:os';
const saved={...process.env};afterEach(()=>{process.env={...saved};});
for(const name of ['first','next'])it(name,()=>{expect(tmpdir()).toBe(process.env.TMPDIR);expect(existsSync(tmpdir())).toBe(true);});`);
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 20_000);

it('relocates the fixed per-user socket namespace in source and inherited Node children', async () => {
  const result = await runFixture(`import path from 'node:path';
it('namespace',()=>{const expected=path.join(process.env.TMPDIR,'agentmonitors-'+process.getuid());const actual=path.join('/tmp','agentmonitors-'+process.getuid());
const child=spawnSync(process.execPath,['-e',"process.stdout.write(require('node:path').join('/tmp','agentmonitors-'+process.getuid()))"],{encoding:'utf8',timeout:3000});
expect(actual).toBe(expected);expect(child.status,child.stderr).toBe(0);expect(child.stdout).toBe(expected);});`);
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 20_000);

it.skipIf(process.platform === 'win32')(
  'keeps the guard on the unrelocated per-user runtime namespace',
  () => {
    const roots = realUserPaths(process.env);
    const dirname = `agentmonitors-${String(process.getuid?.() ?? 0)}`;
    expect(roots).toContain(`/tmp/${dirname}`);
    expect(roots).not.toContain(join(process.env.TMPDIR ?? '', dirname));
  },
);

it('rejects an edit when a foreign descriptor holds only a replaced predecessor', async () => {
  const result = await runFixture(
    `${foreignWrite}\nit('poison',()=>writeFileSync(installation+'/existing','modified'));`,
    false,
    { foreign: true, predecessor: true },
  );
  expect(result.testSummary.numPassedTests).toBe(2);
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('Real user paths changed');
}, 20000);

/** Product fallback resolution must reject an unsafe namespace target before any IO. */
it('rejects transient test access through the product socket resolver', async () => {
  const result = await runFixture(
    `import {resolveSocketPath} from ${JSON.stringify(pathToFileURL(join(repo, 'apps/cli/src/daemon-ipc.ts')).href)};
import {mkdirSync,unlinkSync} from 'node:fs';
it('poison',()=>{process.env.AGENTMONITORS_TEST_SOCKET_ROOT=runtimeBase;let completed=false;
try{const socket=resolveSocketPath('x'.repeat(150));mkdirSync(runtime,{recursive:true});writeFileSync(socket,'test');unlinkSync(socket);completed=true;}catch{}
writeFileSync(receipt,JSON.stringify({completed}));});`,
    false,
    { runtime: true },
  );
  expect(result.testSummary.numPassedTests).toBe(1);
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.receipt.completed).toBe(false);
  expect(result.stdout + result.stderr).toContain('Runtime namespace access');
  expect(result.stdout + result.stderr).toContain(result.runtime);
  expect(result.stdout + result.stderr).toContain('resolveSocketPath');
}, 20000);

it('rejects a test trying to leave a real runtime entry behind', async () => {
  const result = await runFixture(
    `it('poison',()=>{try{writeFileSync(runtime+'/left.sock','test');}catch{}});`,
    false,
    { runtime: true },
  );
  expect(result.testSummary.numPassedTests).toBe(1);
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('Runtime namespace access');
  expect(result.stdout + result.stderr).toContain('left.sock');
}, 20000);

it('keeps a child namespace violation fatal when the test catches its exit', async () => {
  const result = await runFixture(
    `it('poison',()=>{const code="const fs=require('node:fs');const file="+JSON.stringify(runtime+'/child.sock')+";try{fs.writeFileSync(file,'test');fs.unlinkSync(file);}catch{}";
const child=spawnSync(process.execPath,['-e',code],{env:{...process.env},encoding:'utf8',timeout:3000});expect(child.status,child.stdout+child.stderr).not.toBe(0);});`,
    false,
    { runtime: true },
  );
  expect(result.testSummary.numPassedTests, result.stdout + result.stderr).toBe(
    1,
  );
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('Runtime namespace access');
  expect(result.stdout + result.stderr).toContain('child.sock');
}, 20000);

it('reports foreign runtime churn without failing the fixture', async () => {
  const result = await runFixture(foreignWrite, false, {
    runtime: true,
    foreign: true,
    foreignRuntime: 'churn',
  });
  expect(result.testSummary.numPassedTests).toBe(1);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout + result.stderr).toContain('Runtime namespace churn');
  const line = (result.stdout + result.stderr)
    .split('\n')
    .find((value) => value.startsWith('Runtime namespace churn:'));
  if (!line) {
    throw new Error('Missing runtime churn diagnostic');
  }
  const churn = JSON.parse(line.slice('Runtime namespace churn: '.length));
  // Native filename notifications are best-effort. Endpoint directory metadata
  // must still report this known transient write when no name is delivered.
  expect(churn.metadataChanged).toContainEqual(
    expect.objectContaining({ path: result.runtime }),
  );
  expect(churn.netChanges).toEqual([]);
  expect(churn.observationErrors).toEqual([]);
  console.info('Runtime churn receipt:', line);
}, 20000);

it('rejects a net runtime entry even when a foreign process creates it', async () => {
  const result = await runFixture(foreignWrite, false, {
    runtime: true,
    foreign: true,
    foreignRuntime: 'leave',
  });
  expect(result.testSummary.numPassedTests).toBe(1);
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain(
    'Runtime namespace net change',
  );
  expect(result.stdout + result.stderr).toContain('outside.sock');
}, 20000);

/** The same boundary applies to path math, filesystem overloads, and IPC APIs. */
for (const [operation, body] of [
  ['path resolution', "try{path.resolve(runtime,'probe.sock');}catch{}"],
  [
    'buffer open',
    "try{const fd=fs.openSync(Buffer.from(runtime+'/probe.sock'),'r');fs.closeSync(fd);}catch{}",
  ],
  [
    'file URL promises',
    "try{await fs.promises.readFile(pathToFileURL(runtime+'/probe.sock'));}catch{}",
  ],
  [
    'native realpath',
    "try{fs.realpathSync.native(runtime+'/probe.sock');}catch{}",
  ],
  [
    'net server',
    "await new Promise(done=>{const server=net.createServer();server.once('error',()=>done(undefined));try{server.listen(runtime+'/live.sock',()=>server.close(()=>done(undefined)));}catch{done(undefined);}});",
  ],
  [
    'net client',
    "await new Promise(done=>{try{const socket=net.createConnection(runtime+'/probe.sock');socket.once('error',()=>done(undefined));socket.once('connect',()=>socket.end(()=>done(undefined)));}catch{done(undefined);}});",
  ],
  [
    'child cwd',
    "try{spawnSync('pwd',[],{cwd:runtime,encoding:'utf8',timeout:3000});}catch{}",
  ],
] as const) {
  it(`rejects real runtime ${operation} even when the caller catches the error`, async () => {
    const result = await runFixture(
      `import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {pathToFileURL} from 'node:url';
it('poison',async()=>{${body}});`,
      false,
      { runtime: true },
    );
    expect(
      result.testSummary.numPassedTests,
      result.stdout + result.stderr,
    ).toBe(1);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('Runtime namespace access');
    expect(result.stdout + result.stderr).toContain(result.runtime);
  }, 20000);
}

it('retains a child violation receipt with only the preload in its environment', async () => {
  const result = await runFixture(
    `it('poison',()=>{const code="try{require('node:fs').writeFileSync("+JSON.stringify(runtime+'/minimal.sock')+",'test');}catch{};process.exit(0);";
const child=spawnSync(process.execPath,['-e',code],{env:{NODE_OPTIONS:process.env.NODE_OPTIONS},encoding:'utf8',timeout:3000});expect(child.status,child.stdout+child.stderr).not.toBe(0);});`,
    false,
    { runtime: true },
  );
  expect(result.testSummary.numPassedTests, result.stdout + result.stderr).toBe(
    1,
  );
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('minimal.sock');
}, 20000);

/** Function metadata is part of Node's process API, including its result shape. */
it('preserves custom-promisified process stdout and stderr', async () => {
  const result = await runFixture(`import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
it('process output',async()=>{const execute=promisify(execFile);const result=await execute(process.execPath,['-e',"process.stdout.write('out');process.stderr.write('err')"],{encoding:'utf8',timeout:3000});expect(result).toMatchObject({stdout:'out',stderr:'err'});});`);
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 20000);
