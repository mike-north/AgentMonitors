/** POSIX tool symlinks exercise real package-manager boundaries; Windows shims have separate controls. */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, it } from 'vitest';

import { packPackage } from './lib/pack-helpers.mjs';
import { packageManagerEntry } from './lib/package-manager-entry.mjs';

/** Disposable workspace and tool installations never alter the developer's tools. */
const roots: string[] = [];
const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** Use an installed npm launcher without assuming it shares Node's directory. */
function npmEntry(): string {
  const entry = packageManagerEntry('npm');
  if (!entry)
    throw new Error('npm is required for real compatibility fixtures');
  return entry;
}

it.skipIf(process.platform === 'win32')(
  'packs with pnpm under an npm launcher, rewriting workspace dependencies',
  () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), 'am compatibility & spaces-'),
    );
    roots.push(root);
    for (const dir of [
      'core',
      'consumer',
      'packed',
      'consumer/node_modules/@am-compat',
    ])
      mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - core\n  - consumer\n',
    );
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: JSON.parse(
          readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
        ).packageManager,
      }),
    );
    writeFileSync(
      path.join(root, 'core/package.json'),
      JSON.stringify({ name: '@am-compat/core', version: '1.2.3' }),
    );
    writeFileSync(
      path.join(root, 'consumer/package.json'),
      JSON.stringify({
        name: '@am-compat/consumer',
        version: '1.0.0',
        dependencies: { '@am-compat/core': 'workspace:*' },
      }),
    );
    symlinkSync(
      path.join(root, 'core'),
      path.join(root, 'consumer/node_modules/@am-compat/core'),
      'junction',
    );
    process.env.npm_execpath = npmEntry();
    const tarball = packPackage(
      path.join(root, 'consumer'),
      path.join(root, 'packed'),
    );
    const unpack = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
    });
    expect(unpack.status, unpack.stderr).toBe(0);
    expect(JSON.parse(unpack.stdout).dependencies['@am-compat/core']).toBe(
      '1.2.3',
    );
  },
  15000,
);

it.skipIf(process.platform === 'win32')(
  'reaches real npm through PATH when Node and npm are installed separately',
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'am split node & npm-'));
    roots.push(root);
    const nodeDir = path.join(root, 'separate-node', 'bin');
    const npmDir = path.join(root, 'separate-npm', 'bin');
    mkdirSync(nodeDir, { recursive: true });
    mkdirSync(npmDir, { recursive: true });
    const node = path.join(nodeDir, path.basename(process.execPath));
    symlinkSync(process.execPath, node);
    symlinkSync(npmEntry(), path.join(npmDir, 'npm'));
    // Stop exactly at installation: this test checks discovery, not network/native installs.
    const probe = `
    import { syncBuiltinESMExports } from 'node:module';
    import cp from 'node:child_process';
    import fs from 'node:fs';
    const realSpawn = cp.spawnSync;
    cp.spawnSync = (command, args, options) => {
      if (args.includes('pack')) {
        const dest = args[args.indexOf('--pack-destination') + 1];
        fs.writeFileSync(dest + '/' + fs.readdirSync(dest).length + '.tgz', 'fixture');
        return {status:0, stdout:'', stderr:''};
      }
      if (args.includes('install')) {
        if (options.shell) throw new Error('shell forbidden');
        const result = realSpawn(command, [args[0], '--version'], {encoding:'utf8'});
        if (result.status !== 0) throw new Error(result.stderr);
        console.log('resolved-real-npm:' + result.stdout.trim());
        throw new Error('installation boundary reached');
      }
      return realSpawn(command, args, options);
    };
    syncBuiltinESMExports();
    process.execPath = ${JSON.stringify(node)};
    const {main} = await import(${JSON.stringify(pathToFileURL(path.resolve('scripts/test-windows-install.mjs')).href)});
    await main();
  `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', probe],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: npmDir,
          TMPDIR: root,
          npm_execpath: '',
        },
      },
    );
    expect(result.stdout, result.stderr).toMatch(/resolved-real-npm:\d+\./);
    expect(result.stderr).toContain('installation boundary reached');
  },
  15000,
);
