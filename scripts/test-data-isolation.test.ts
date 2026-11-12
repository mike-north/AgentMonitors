/**
 * The suite boundary must isolate inherited host paths and detect accidental
 * writes to an installation. Nested suites use a fake installation, so even
 * the negative controls cannot damage a developer's files.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';
import { realUserPaths } from './test-isolation/paths.mjs';
import {
  allGuardedVitestConfigPaths,
  importVitestConfig,
} from './vitest-pass-with-no-tests.mjs';

const repo = resolve(import.meta.dirname, '..');

/** Run the real configured boundary with only owned directories as host paths. */
async function runFixture(body: string, linked = false) {
  const dir = mkdtempSync(join(tmpdir(), 'isolation-proof-'));
  const home = join(dir, 'real-home');
  const installation = join(home, '.local/share/agentmonitors');
  const receipt = join(dir, 'receipt.json');
  if (linked) {
    const target = join(dir, 'installation-target');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(home, '.local/share'), { recursive: true });
    symlinkSync(target, installation, 'dir');
  } else {
    mkdirSync(installation, { recursive: true });
  }
  writeFileSync(join(installation, 'existing'), 'original');
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
${body}`,
  );
  try {
    // A threads-only Vitest fixture owns no detached processes. Node's
    // synchronous deadline bounds its one process and all worker threads;
    // the environment probe below is also synchronous and separately bounded.
    const result = spawnSync(
      process.execPath,
      [join(repo, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config],
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
          AGENTMONITORS_SOCKET: join(dir, 'real.sock'),
        },
        timeout: 15_000,
      },
    );
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    return {
      ...result,
      installation,
      receipt: existsSync(receipt)
        ? JSON.parse(readFileSync(receipt, 'utf8'))
        : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
it('poison',()=>{const file=installation+'/existing'; const stat=statSync(file);writeFileSync(file,'modified');utimesSync(file,stat.atime,stat.mtime);});`);
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('Real user paths changed');
  expect(result.stdout + result.stderr).toContain('existing');
}, 20_000);

for (const outcome of ['pass', 'fail', 'timeout']) {
  it(`isolates inherited paths and children, and cleans up after ${outcome}`, async () => {
    const result = await runFixture(`it('case',async()=>{
const keys=['HOME','XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR','TMPDIR'];
const env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const child=spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify(process.env))'],{encoding:'utf8',timeout:3000});
writeFileSync(receipt,JSON.stringify({env,child:JSON.parse(child.stdout)}));
${outcome === 'fail' ? 'expect(1).toBe(2);' : outcome === 'timeout' ? 'await new Promise(()=>{});' : "expect(process.env.AGENTMONITORS_DB??'').not.toContain(installation);expect(process.env.AGENTMONITORS_SOCKET).toBeUndefined();"}
},50);`);
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

it.each(allGuardedVitestConfigPaths())(
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
      if (outcome === 'throw') expect(result.status, result.stderr).not.toBe(0);
      else expect(result.status, result.stderr).toBe(0);
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
    expect(roots).toContain(resolve('/tmp', dirname));
    expect(roots).not.toContain(join(process.env.TMPDIR ?? '', dirname));
  },
);
