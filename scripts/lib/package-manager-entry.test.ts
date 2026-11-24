/** Resolver controls isolate installed JS files from non-executable command shims. */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { packageManagerEntry } from './package-manager-entry.mjs';

/** Restore selection inputs so host installations cannot make absence tests pass. */
const node = process.execPath;
const originalEnv = { ...process.env };
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const roots: string[] = [];
afterEach(() => {
  process.execPath = node;
  if (platformDescriptor)
    Object.defineProperty(process, 'platform', platformDescriptor);
  vi.unstubAllEnvs();
  process.env = { ...originalEnv };
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

/** Discovery must retain every supported Node module extension under other managers. */
describe.each(['official Windows', 'official POSIX', 'Windows PATH'])(
  'pnpm discovery under npm (%s)',
  (layout) => {
    it.each(['cjs', 'js', 'mjs', undefined])(
      'selects only the installed pnpm launcher (%s)',
      (extension) => {
        const root = realpathSync(
          mkdtempSync(path.join(os.tmpdir(), 'am pnpm discovery & spaces-')),
        );
        roots.push(root);
        const nodeDir = path.join(root, 'separate node', 'bin');
        const toolsDir = path.join(root, 'separate tools');
        mkdirSync(nodeDir, { recursive: true });
        mkdirSync(toolsDir, { recursive: true });
        process.execPath = path.join(nodeDir, 'node.exe');
        Object.defineProperty(process, 'platform', {
          value: layout === 'official POSIX' ? 'linux' : 'win32',
        });
        vi.stubEnv('PATH', toolsDir);
        const npm = path.join(root, 'npm-cli.js');
        writeFileSync(npm, 'throw new Error("npm cannot replace pnpm");');
        vi.stubEnv('npm_execpath', npm);
        writeFileSync(
          path.join(toolsDir, 'pnpm.cmd'),
          '@echo never execute this shim',
        );
        const packageDir =
          layout === 'Windows PATH'
            ? path.join(toolsDir, 'node_modules/pnpm/bin')
            : path.join(
                nodeDir,
                layout === 'official POSIX'
                  ? '../lib/node_modules/pnpm/bin'
                  : 'node_modules/pnpm/bin',
              );
        mkdirSync(packageDir, { recursive: true });
        const entry = extension
          ? path.join(packageDir, `pnpm.${extension}`)
          : undefined;
        if (entry) {
          writeFileSync(
            entry,
            'console.log(JSON.stringify(process.argv.slice(2)));',
          );
        }
        const resolved = packageManagerEntry('pnpm');
        expect(resolved).toBe(entry);
        if (!entry) return;
        if (!resolved)
          throw new Error('installed pnpm launcher was not resolved');
        const result = spawnSync(node, [resolved, 'literal & spaces'], {
          encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(['literal & spaces']);
      },
    );
  },
);

/** Corepack's named proxies belong to their manager, even under another launcher. */
describe.each(['official Windows', 'Windows PATH'])(
  'Corepack pnpm (%s)',
  (layout) => {
    it.each(['npm-cli.js', 'yarn.js', 'bun.js', undefined])(
      'discovers pnpm under %s',
      (parent) => {
        const root = realpathSync(
          mkdtempSync(path.join(os.tmpdir(), 'am corepack & spaces-')),
        );
        roots.push(root);
        const nodeDir = path.join(root, 'node');
        const toolsDir = path.join(root, 'tools');
        mkdirSync(nodeDir, { recursive: true });
        mkdirSync(toolsDir, { recursive: true });
        process.execPath = path.join(nodeDir, 'node.exe');
        Object.defineProperty(process, 'platform', { value: 'win32' });
        process.env = { PATH: toolsDir };
        if (parent) {
          process.env.npm_execpath = path.join(root, parent);
          writeFileSync(
            process.env.npm_execpath,
            'throw new Error("wrong manager");',
          );
        }
        writeFileSync(
          path.join(toolsDir, 'pnpm.cmd'),
          '@echo never execute this shim',
        );
        const entry = path.join(
          layout === 'official Windows' ? nodeDir : toolsDir,
          'node_modules/corepack/dist/pnpm.js',
        );
        mkdirSync(path.dirname(entry), { recursive: true });
        writeFileSync(
          entry,
          'console.log(JSON.stringify(process.argv.slice(2)));',
        );
        const resolved = packageManagerEntry('pnpm');
        expect(resolved).toBe(entry);
        if (!resolved) throw new Error('Corepack pnpm was not found');
        const result = spawnSync(node, [resolved, 'literal & spaces'], {
          encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(['literal & spaces']);
      },
    );
  },
);

it.each(['invoking', 'PATH'])(
  'recognizes the named Corepack npm proxy via %s',
  (selection) => {
    const root = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'am corepack npm-')),
    );
    roots.push(root);
    const tools = path.join(root, 'tools');
    const entry = path.join(root, 'packages/corepack/dist/npm.js');
    mkdirSync(tools, { recursive: true });
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)));');
    process.execPath = path.join(root, 'separate-node/node');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env = { PATH: selection === 'PATH' ? tools : '' };
    if (selection === 'invoking') process.env.npm_execpath = entry;
    // A PATH link must resolve to the Corepack proxy, not to npm-cli.js.
    if (selection === 'PATH') symlinkSync(entry, path.join(tools, 'npm'));
    const resolved = packageManagerEntry('npm');
    expect(resolved).toBe(entry);
    if (!resolved) throw new Error('Corepack npm was not found');
    const result = spawnSync(node, [resolved, 'literal & spaces'], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['literal & spaces']);
  },
);

it.each(['pnpm.js', 'yarn.js', 'bun.js'])(
  'rejects another Corepack manager (%s) as npm',
  (filename) => {
    const root = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'am corepack isolation-')),
    );
    roots.push(root);
    const entry = path.join(root, 'node_modules/corepack/dist', filename);
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, 'throw new Error("wrong manager");');
    process.execPath = path.join(root, 'node');
    process.env = { PATH: root, npm_execpath: entry };
    expect(packageManagerEntry('npm')).toBeUndefined();
  },
);

/** POSIX treats differently cased variables as unrelated; Windows accepts Path. */
it.each([
  ['linux', 'PATH'],
  ['linux', 'Path-before-PATH'],
  ['linux', 'Path-only'],
  ['win32', 'Path-only'],
  ['win32', 'missing'],
])('selects the correct path variable for %s with %s', (platform, variant) => {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'am path case-')),
  );
  roots.push(root);
  const tools = path.join(root, 'tools');
  const entry = path.join(tools, 'node_modules/npm/bin/npm-cli.js');
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)));');
  process.execPath = path.join(root, 'separate-node/node');
  Object.defineProperty(process, 'platform', { value: platform });
  process.env = {};
  if (variant === 'Path-before-PATH')
    process.env.Path = path.join(root, 'unrelated');
  if (variant === 'PATH' || variant === 'Path-before-PATH')
    process.env.PATH = tools;
  if (variant === 'Path-only') process.env.Path = tools;
  const shouldFind =
    variant !== 'missing' && !(platform === 'linux' && variant === 'Path-only');
  const resolved = packageManagerEntry('npm');
  expect(resolved).toBe(shouldFind ? entry : undefined);
  if (resolved) {
    const result = spawnSync(node, [resolved, 'literal & spaces'], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['literal & spaces']);
  }
});

it('does not treat an arbitrary npm.js file as a Corepack npm proxy', () => {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'am npm identity-')),
  );
  roots.push(root);
  const entry = path.join(root, 'unrelated/dist/npm.js');
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, 'throw new Error("not Corepack npm");');
  process.execPath = path.join(root, 'node');
  process.env = { PATH: '', npm_execpath: entry };
  expect(packageManagerEntry('npm')).toBeUndefined();
});

/** A launcher selected in one cwd must still identify that file in another cwd. */
describe.skipIf(process.platform === 'win32').each(['npm', 'pnpm'])(
  'cwd-independent %s launcher identity',
  (manager) => {
    it.each([
      'relative PATH',
      'absolute PATH',
      'relative invoking',
      'absolute invoking',
    ])('executes the selected launcher from a child cwd (%s)', (selection) => {
      const root = realpathSync(
        mkdtempSync(path.join(os.tmpdir(), 'am launcher identity & spaces-')),
      );
      roots.push(root);
      const bin = path.join(root, 'prefix/bin');
      const entry = path.join(
        root,
        'prefix/lib/node_modules',
        manager,
        manager === 'npm' ? 'bin/npm-cli.js' : 'bin/pnpm.cjs',
      );
      const packed = path.join(root, 'packed child');
      const separateNode = path.join(root, 'separate-node/node');
      mkdirSync(bin, { recursive: true });
      mkdirSync(path.dirname(entry), { recursive: true });
      mkdirSync(packed, { recursive: true });
      mkdirSync(path.dirname(separateNode), { recursive: true });
      symlinkSync(node, separateNode);
      symlinkSync(node, path.join(bin, 'node'));
      writeFileSync(
        entry,
        'console.log(JSON.stringify(process.argv.slice(2)));',
      );
      // A genuine executable command, not a symlink to the JS launcher: this
      // keeps discovery on the relative prefix/lib candidate that regressed.
      writeFileSync(
        path.join(bin, manager),
        `#!/usr/bin/env node
require(${JSON.stringify(entry)});`,
        { mode: 0o755 },
      );
      const searchPath = selection === 'relative PATH' ? './prefix/bin' : bin;
      const invoking =
        selection === 'relative invoking'
          ? path.relative(root, entry)
          : selection === 'absolute invoking'
            ? entry
            : '';
      const env = { ...process.env, PATH: searchPath, npm_execpath: invoking };
      const lookup = spawnSync(manager, ['literal & spaces'], {
        cwd: root,
        encoding: 'utf8',
        env,
      });
      expect(lookup.status, lookup.stderr).toBe(0);
      expect(JSON.parse(lookup.stdout)).toEqual(['literal & spaces']);
      const discovery = spawnSync(
        node,
        [
          '--input-type=module',
          '-e',
          `
          import {spawnSync} from 'node:child_process';
          import {packageManagerEntry} from ${JSON.stringify(pathToFileURL(path.resolve('scripts/lib/package-manager-entry.mjs')).href)};
          process.execPath = ${JSON.stringify(separateNode)};
          const selected = packageManagerEntry(${JSON.stringify(manager)});
          const result = spawnSync(${JSON.stringify(node)}, [selected, 'literal & spaces'], {cwd:${JSON.stringify(packed)}, encoding:'utf8'});
          console.log(JSON.stringify({selected, status:result.status, stdout:result.stdout, stderr:result.stderr}));
        `,
        ],
        { cwd: root, encoding: 'utf8', env },
      );
      expect(discovery.status, discovery.stderr).toBe(0);
      const result = JSON.parse(discovery.stdout);
      expect(result.status, result.stderr).toBe(0);
      expect(result.selected).toBe(entry);
      expect(JSON.parse(result.stdout)).toEqual(['literal & spaces']);
    });
  },
);
