/** Resolver controls isolate installed JS files from non-executable command shims. */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { packageManagerEntry } from './package-manager-entry.mjs';

/** Restore selection inputs so host installations cannot make absence tests pass. */
const node = process.execPath;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const roots: string[] = [];
afterEach(() => {
  process.execPath = node;
  if (platformDescriptor)
    Object.defineProperty(process, 'platform', platformDescriptor);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('resolves Windows PATH npm package beside a cmd shim without executing the shim', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'am resolver & spaces-'));
  roots.push(root);
  process.execPath = path.join(root, 'separate node/node.exe');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('npm_execpath', path.join(root, 'pnpm.mjs'));
  vi.stubEnv('PATH', root);
  const entry = path.join(root, 'node_modules/npm/bin/npm-cli.js');
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(path.join(root, 'npm.cmd'), '@echo this is not JavaScript');
  writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)));');
  expect(packageManagerEntry('npm')).toBe(realpathSync(entry));
  const result = spawnSync(node, [entry, 'literal & spaces'], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(['literal & spaces']);
});

it('reports absence rather than selecting another manager or a bare cmd shim', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'am missing manager-'));
  roots.push(root);
  process.execPath = path.join(root, 'node');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('npm_execpath', path.join(root, 'yarn.js'));
  vi.stubEnv('PATH', root);
  writeFileSync(path.join(root, 'npm.cmd'), '@echo no npm package here');
  writeFileSync(
    path.join(root, 'yarn.js'),
    'throw new Error("wrong manager");',
  );
  expect(packageManagerEntry('npm')).toBeUndefined();
  expect(packageManagerEntry('pnpm')).toBeUndefined();
});
