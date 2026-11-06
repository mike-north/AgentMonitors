/** Filesystem traversal and POSIX PATH components determine launcher identity. */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { packageManagerEntry } from './package-manager-entry.mjs';

/** Canonical roots make expected identities independent of macOS temporary aliases. */
const roots: string[] = [];
const node = process.execPath;
const resolver = pathToFileURL(
  path.resolve('scripts/lib/package-manager-entry.mjs'),
).href;
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A symlink's parent is physical/; lexical collapse instead points at the root. */
function traversalFixture() {
  const root = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), 'am physical & spaces-')),
  );
  roots.push(root);
  for (const dir of [
    'physical/deep',
    'physical/bin',
    'bin',
    'packed',
    'separate-node',
  ])
    mkdirSync(path.join(root, dir), { recursive: true });
  symlinkSync(path.join(root, 'physical/deep'), path.join(root, 'link'));
  return root;
}

/** Execute the actual selected launcher in a different cwd, preserving literal argv. */
function selectedExecution(
  root: string,
  manager: string,
  env: NodeJS.ProcessEnv,
) {
  const result = spawnSync(
    node,
    [
      '--input-type=module',
      '-e',
      `
    import {spawnSync} from 'node:child_process';
    import {packageManagerEntry} from ${JSON.stringify(resolver)};
    process.execPath = ${JSON.stringify(path.join(root, 'separate-node/node'))};
    const selected = packageManagerEntry(${JSON.stringify(manager)});
    const run = selected && spawnSync(${JSON.stringify(node)}, [selected, 'literal & spaces'], {cwd:${JSON.stringify(path.join(root, 'packed'))}, encoding:'utf8'});
    console.log(JSON.stringify({selected, status:run?.status, stdout:run?.stdout, stderr:run?.stderr}));
  `,
    ],
    { cwd: root, env, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

/** The decoy executes successfully, so content assertions must identify the right file. */
function launcher(file: string, identity: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `console.log(JSON.stringify({identity:${JSON.stringify(identity)}, argv:process.argv.slice(2)}));`,
  );
}

describe.skipIf(process.platform === 'win32').each(['npm', 'pnpm'])(
  'physical %s invoking identity',
  (manager) => {
    it.each(['relative traversal', 'absolute traversal', 'physical control'])(
      'executes the physical file (%s)',
      (selection) => {
        const root = traversalFixture();
        const filename = manager === 'npm' ? 'npm-cli.js' : 'pnpm.cjs';
        const expected = path.join(root, 'physical/bin', filename);
        launcher(expected, 'physical');
        launcher(path.join(root, 'bin', filename), 'decoy');
        const relative = `link/../bin/${filename}`;
        const absolute = `${root}/${relative}`;
        expect(readFileSync(absolute, 'utf8')).toBe(
          readFileSync(expected, 'utf8'),
        );
        const invoking =
          selection === 'relative traversal'
            ? relative
            : selection === 'absolute traversal'
              ? absolute
              : expected;
        const result = selectedExecution(root, manager, {
          ...process.env,
          PATH: '',
          npm_execpath: invoking,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          identity: 'physical',
          argv: ['literal & spaces'],
        });
        expect(result.selected).toBe(expected);
      },
    );
  },
);

describe.skipIf(process.platform === 'win32').each(['npm', 'pnpm'])(
  'physical %s PATH directory',
  (manager) => {
    it.each(['relative traversal', 'absolute traversal', 'physical control'])(
      'follows the native lookup directory (%s)',
      (selection) => {
        const root = traversalFixture();
        const relative =
          manager === 'npm' ? 'npm/bin/npm-cli.js' : 'pnpm/bin/pnpm.cjs';
        const expected = path.join(root, 'physical/bin/node_modules', relative);
        launcher(expected, 'physical');
        launcher(path.join(root, 'bin/node_modules', relative), 'decoy');
        // Native executables isolate OS PATH lookup from Node's script-argv normalization.
        symlinkSync(
          '/usr/bin/printf',
          path.join(root, 'physical/bin', manager),
        );
        symlinkSync('/usr/bin/false', path.join(root, 'bin', manager));
        const searchPath =
          selection === 'relative traversal'
            ? 'link/../bin'
            : selection === 'absolute traversal'
              ? `${root}/link/../bin`
              : path.join(root, 'physical/bin');
        const env = { ...process.env, PATH: searchPath, npm_execpath: '' };
        const native = spawnSync(
          manager,
          ['physical-command:%s', 'literal & spaces'],
          { cwd: root, env, encoding: 'utf8' },
        );
        expect(native.status, native.stderr).toBe(0);
        expect(native.stdout).toBe('physical-command:literal & spaces');
        const result = selectedExecution(root, manager, env);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          identity: 'physical',
          argv: ['literal & spaces'],
        });
        expect(result.selected).toBe(expected);
      },
    );
  },
);

/** Empty entries are cwd only when explicitly supplied on POSIX; absence stays absent. */
it
  .skipIf(process.platform === 'win32')
  .each([
    'leading',
    'trailing',
    'repeated',
    'empty',
    'dot',
    'unset',
    'missing only',
    'missing then valid',
    'file then valid',
    'Windows empty',
  ])('discovers npm with POSIX PATH components (%s)', (variant) => {
  const root = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), 'am empty PATH-')),
  );
  roots.push(root);
  const installed = packageManagerEntry('npm');
  if (!installed)
    throw new Error('real npm is required for PATH lookup fixtures');
  const expected = realpathSync.native(installed);
  symlinkSync(installed, path.join(root, 'npm'));
  symlinkSync(node, path.join(root, 'node'));
  mkdirSync(path.join(root, 'separate-node'));
  mkdirSync(path.join(root, 'packed'));
  const missing = path.join(root, 'missing');
  const nonDirectory = path.join(root, 'bad-prefix/not-directory');
  mkdirSync(path.dirname(nonDirectory), { recursive: true });
  writeFileSync(nonDirectory, 'not a PATH directory');
  launcher(
    path.join(root, 'bad-prefix/lib/node_modules/npm/bin/npm-cli.js'),
    'decoy',
  );
  const paths: Record<string, string | undefined> = {
    leading: `:${missing}`,
    trailing: `${missing}:`,
    repeated: `${missing}::${missing}`,
    empty: '',
    dot: '.',
    unset: undefined,
    'missing only': missing,
    'missing then valid': `${missing}:${root}`,
    'file then valid': `${nonDirectory}:${root}`,
    'Windows empty': '',
  };
  const env: NodeJS.ProcessEnv = { ...process.env, npm_execpath: '' };
  delete env.PATH;
  if (paths[variant] !== undefined) env.PATH = paths[variant];
  const shouldFind = !['unset', 'missing only', 'Windows empty'].includes(
    variant,
  );
  let version = '';
  if (shouldFind) {
    const lookup = spawnSync('npm', ['--version'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    expect(lookup.status, lookup.stderr).toBe(0);
    expect(lookup.stdout.trim()).toMatch(/^\d+\./);
    version = lookup.stdout.trim();
  }
  const discovery = spawnSync(
    node,
    [
      '--input-type=module',
      '-e',
      `
    import {spawnSync} from 'node:child_process';
    import {packageManagerEntry} from ${JSON.stringify(resolver)};
    process.execPath = ${JSON.stringify(path.join(root, 'separate-node/node'))};
    if (${JSON.stringify(variant)} === 'Windows empty') Object.defineProperty(process, 'platform', {value:'win32'});
    const selected = packageManagerEntry('npm');
    const run = selected && spawnSync(${JSON.stringify(node)}, [selected, '--version'], {cwd:${JSON.stringify(path.join(root, 'packed'))}, encoding:'utf8'});
    console.log(JSON.stringify({selected, status:run?.status, stdout:run?.stdout, stderr:run?.stderr}));
  `,
    ],
    { cwd: root, env, encoding: 'utf8' },
  );
  expect(discovery.status, discovery.stderr).toBe(0);
  const result = JSON.parse(discovery.stdout);
  expect(result.selected).toBe(shouldFind ? expected : undefined);
  if (shouldFind) {
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  }
});

/** Manager recognition follows the physical named Corepack package, too. */
it.skipIf(process.platform === 'win32').each(['relative', 'absolute'])(
  'recognizes a physically named Corepack npm proxy through %s traversal',
  (selection) => {
    const root = traversalFixture();
    const expected = path.join(root, 'physical/corepack/dist/npm.js');
    mkdirSync(path.join(root, 'physical/corepack/deep'), { recursive: true });
    symlinkSync(
      path.join(root, 'physical/corepack/deep'),
      path.join(root, 'proxy-link'),
    );
    launcher(expected, 'physical');
    launcher(path.join(root, 'dist/npm.js'), 'decoy');
    const raw = 'proxy-link/../dist/npm.js';
    const result = selectedExecution(root, 'npm', {
      ...process.env,
      PATH: '',
      npm_execpath: selection === 'relative' ? raw : `${root}/${raw}`,
    });
    expect(result.selected).toBe(expected);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      identity: 'physical',
      argv: ['literal & spaces'],
    });
  },
);
