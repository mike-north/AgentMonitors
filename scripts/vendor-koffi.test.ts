/** Offline checks protect native provenance and direct-entry versus inert-import behavior. */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
/** Entry detection must work regardless of how Node preserves the main module's symlink. */
const entryModes = [
  { name: 'default resolution', flags: [], nodeOptions: '' },
  {
    name: '--preserve-symlinks-main flag',
    flags: ['--preserve-symlinks-main'],
    nodeOptions: '',
  },
  {
    name: 'NODE_OPTIONS preservation',
    flags: [],
    nodeOptions: '--preserve-symlinks-main',
  },
];
describe('vendored Koffi provenance', () => {
  it('matches every committed file and its hash in both packages without network', async () => {
    const { verifyFile } = await import('./vendor-koffi.mjs');
    for (const dir of ['apps/cli', 'plugins/source-command-poll']) {
      const vendor = path.join(root, dir, 'vendor/koffi');
      const manifest = JSON.parse(
        readFileSync(path.join(vendor, 'manifest.json'), 'utf8'),
      );
      expect(manifest.version).toBe('3.3.7');
      const actual = readdirSync(vendor, {
        recursive: true,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          path
            .relative(vendor, path.join(entry.parentPath, entry.name))
            .replaceAll('\\', '/'),
        )
        .sort();
      expect(actual).toEqual(
        [
          'manifest.json',
          ...manifest.files.map((file: { path: string }) => file.path),
        ].sort(),
      );
      for (const file of manifest.files) {
        expect(() =>
          verifyFile(
            readFileSync(path.join(vendor, file.path)),
            file.sha256,
            file.path,
          ),
        ).not.toThrow();
        if (file.tarball) expect(file.integrity).toMatch(/^sha512-/);
        if (file.source)
          expect(readFileSync(path.join(vendor, file.path))).toEqual(
            readFileSync(path.join(root, file.source)),
          );
      }
    }
  });
  it('rejects a tampered sha512 integrity before extracting a download', async () => {
    const { verifyIntegrity } = await import('./vendor-koffi.mjs');
    const bytes = Buffer.from('registry tarball');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    expect(() => verifyIntegrity(bytes, integrity)).not.toThrow();
    expect(() =>
      verifyIntegrity(Buffer.from('tampered tarball'), integrity),
    ).toThrow(/integrity/);
    expect(() => verifyIntegrity(bytes, 'sha512-tampered')).toThrow(
      /integrity/,
    );
  });
  it('rejects tampered vendored bytes against the committed digest', async () => {
    const { verifyFile } = await import('./vendor-koffi.mjs');
    const vendor = path.join(root, 'plugins/source-command-poll/vendor/koffi');
    const manifest = JSON.parse(
      readFileSync(path.join(vendor, 'manifest.json'), 'utf8'),
    );
    const file = manifest.files.find((file: { path: string }) =>
      file.path.endsWith('.node'),
    );
    const bytes = readFileSync(path.join(vendor, file.path));
    bytes[0] ^= 1;
    expect(() => verifyFile(bytes, file.sha256, file.path)).toThrow(/sha256/);
  });
});

/** Construct regular-file tar members so a missing integrity gate can really extract them. */
function fixtureArchive(): Buffer {
  const members = {
    'package/src/koffi/indirect.cjs': Buffer.from(
      'var [version, pkg, triplets] = detectPlatform2();\nvar native = loadDynamic2(__dirname, pkg, triplets);\nmodule.exports = {};',
    ),
    'package/LICENSE.txt': Buffer.from('fixture license'),
    ...Object.fromEntries(
      ['darwin_arm64', 'darwin_x64', 'linux_x64', 'linux_arm64'].map(
        (platform) => [
          `package/${platform}/koffi.node`,
          Buffer.from('fixture native'),
        ],
      ),
    ),
  };
  const blocks: Buffer[] = [];
  for (const [name, bytes] of Object.entries(members)) {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
    header[156] = 48;
    blocks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/** A copied refresh entry point owns only fixture output, even if admission regresses. */
function refreshFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vk-'));
  mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
  copyFileSync(
    path.join(root, 'scripts/vendor-koffi.mjs'),
    path.join(dir, 'scripts/vendor-koffi.mjs'),
  );
  copyFileSync(
    path.join(root, 'scripts/lib/koffi-loader.cjs'),
    path.join(dir, 'scripts/lib/koffi-loader.cjs'),
  );
  writeFileSync(path.join(dir, 'fixture.tgz'), fixtureArchive());
  for (const pkg of ['apps/cli', 'plugins/source-command-poll']) {
    const vendor = path.join(dir, pkg, 'vendor/koffi');
    mkdirSync(vendor, { recursive: true });
    writeFileSync(path.join(vendor, 'sentinel'), 'keep existing payload');
  }
  return dir;
}

describe('refresh entry point admission', () => {
  it('rejects mismatched registry integrity through main before extracting or changing either output', () => {
    const dir = refreshFixture();
    // All downloads are valid fixture archives. Without main's integrity gate,
    // the whole refresh completes and overwrites both output directories.
    writeFileSync(
      path.join(dir, 'probe.mjs'),
      `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { main } from './scripts/vendor-koffi.mjs';
      const archive = readFileSync(new URL('./fixture.tgz', import.meta.url));
      let requests = 0;
      globalThis.fetch = async (url) => {
        requests++;
        const name = new URL(url).pathname.slice(1, -'/3.3.7'.length);
        return { ok: true,
          json: async () => ({ name, version: '3.3.7', dist: {
            tarball: 'https://registry.npmjs.org/fixture.tgz',
            integrity: 'sha512-' + Buffer.alloc(64).toString('base64')
          }}),
          arrayBuffer: async () => archive
        };
      };
      await assert.rejects(main(), /Koffi tarball sha512 integrity mismatch/);
      assert.equal(requests, 2, 'refuse the first archive before further downloads');
    `,
    );
    const result = spawnSync(process.execPath, [path.join(dir, 'probe.mjs')], {
      encoding: 'utf8',
    });
    for (const pkg of ['apps/cli', 'plugins/source-command-poll']) {
      const vendor = path.join(dir, pkg, 'vendor/koffi');
      expect(readdirSync(vendor, { recursive: true })).toEqual(['sentinel']);
      expect(readFileSync(path.join(vendor, 'sentinel'), 'utf8')).toBe(
        'keep existing payload',
      );
    }
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(entryModes)(
    'runs refresh main through a checkout alias with spaces: $name',
    ({ flags, nodeOptions }) => {
      const dir = refreshFixture();
      const alias = path.join(dir, 'checkout with spaces');
      symlinkSync(dir, alias, 'junction');
      // The preload refuses every network attempt. Its diagnostic proves main ran;
      // the broken direct-entry guard instead returns a silent successful no-op.
      const preload = path.join(dir, 'offline.cjs');
      writeFileSync(
        preload,
        "globalThis.fetch = async () => { throw new Error('offline refresh reached registry'); };\n",
      );
      const result = spawnSync(
        process.execPath,
        [
          '--require',
          preload,
          ...flags,
          path.join(alias, 'scripts/vendor-koffi.mjs'),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: nodeOptions },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('offline refresh reached registry');
      for (const pkg of ['apps/cli', 'plugins/source-command-poll']) {
        expect(readdirSync(path.join(dir, pkg, 'vendor/koffi'))).toEqual([
          'sentinel',
        ]);
      }
    },
  );
});

it.each(entryModes)(
  'runs standalone main through a checkout alias with spaces: $name',
  ({ flags, nodeOptions }) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sc-link-'));
    const alias = path.join(dir, 'checkout with spaces');
    symlinkSync(root, alias, 'junction');
    const preload = path.join(dir, 'offline.cjs');
    // Stop at the first build before any install or registry traffic. Other
    // subprocesses remain available to the test-isolation boundary's inspection.
    writeFileSync(
      preload,
      `
    const cp = require('node:child_process');
    const original = cp.spawnSync;
    cp.spawnSync = (command, args, options) => {
      if (args?.length === 1 && args[0] === 'build') {
        throw new Error('offline consumer reached build');
      }
      return original(command, args, options);
    };
    require('node:module').syncBuiltinESMExports();
  `,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--require',
        preload,
        ...flags,
        path.join(alias, 'scripts/test-standalone-consumer.mjs'),
      ],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: nodeOptions } },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Building published packages...');
    expect(result.stderr).toContain('offline consumer reached build');
  },
);

/** Imports must never run command work merely because an importer has a non-module argv. */
describe.each(['vendor-koffi.mjs', 'test-standalone-consumer.mjs'])(
  '%s inert imports',
  (filename) => {
    it.each(['absent', 'missing target', '-e'])(
      'does not run main with argv[1] %s',
      (argvCase) => {
        const dir = mkdtempSync(path.join(tmpdir(), 'entry-import-'));
        const argv =
          argvCase === 'absent'
            ? undefined
            : argvCase === 'missing target'
              ? path.join(dir, 'missing.mjs')
              : '-e';
        // Accidental command work must fail offline before it can build packages
        // or fetch a registry payload.
        const result = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
      import { syncBuiltinESMExports } from 'node:module';
      import cp from 'node:child_process';
      globalThis.fetch = async () => { throw new Error('unexpected refresh main'); };
      const original = cp.spawnSync;
      cp.spawnSync = (command, args, options) => {
        if (args?.length === 1 && args[0] === 'build') throw new Error('unexpected consumer main');
        return original(command, args, options);
      };
      syncBuiltinESMExports();
      process.argv[1] = ${JSON.stringify(argv) ?? 'undefined'};
      await import(${JSON.stringify(pathToFileURL(path.join(root, 'scripts', filename)).href)});
      console.log('INERT_IMPORT');
    `,
          ],
          { encoding: 'utf8' },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe('INERT_IMPORT');
        expect(result.stderr).toBe('');
      },
    );
  },
);
