/** The real nested fixtures must accept POSIX pnpm executables without JS discovery. */
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

import { expect, it } from 'vitest';

import { packageManagerEntry } from './lib/package-manager-entry.mjs';

it.skipIf(process.platform === 'win32').each([true, false])(
  'runs the actual outer fixture with executable-only pnpm available=%s',
  (available) => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), 'am executable pnpm & spaces-'),
    );
    try {
      const tools = path.join(root, 'tools');
      const nodeDir = path.join(root, 'node-only');
      mkdirSync(tools, { recursive: true });
      mkdirSync(nodeDir, { recursive: true });
      const npm = packageManagerEntry('npm');
      const pnpm = packageManagerEntry('pnpm');
      if (!npm) throw new Error('real npm is required for executable fixtures');
      symlinkSync(npm, path.join(tools, 'npm'));
      symlinkSync(process.execPath, path.join(tools, 'node'));
      const separateNode = path.join(nodeDir, 'node');
      symlinkSync(process.execPath, separateNode);
      const argvLog = path.join(root, 'pnpm-argv.jsonl');
      // Delegation retains the caller's working PATH if pnpm itself is executable-only.
      // Neither this fixture nor the production JS resolver interprets executable contents.
      const delegates = [
        { name: 'tar', command: 'tar', prefix: [] },
        ...(available
          ? [
              {
                name: 'pnpm',
                command: pnpm ? process.execPath : 'pnpm',
                prefix: pnpm ? [pnpm] : [],
              },
            ]
          : []),
      ];
      for (const delegate of delegates) {
        writeFileSync(
          path.join(tools, delegate.name),
          `#!/usr/bin/env node
          const fs = require('node:fs');
          const {spawnSync} = require('node:child_process');
          if (${JSON.stringify(delegate.name)} === 'pnpm') fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
          const result = spawnSync(${JSON.stringify(delegate.command)}, [...${JSON.stringify(delegate.prefix)}, ...process.argv.slice(2)], {stdio:'inherit', env:{...process.env, PATH:${JSON.stringify(process.env.PATH ?? '')}}});
          if (result.error) throw result.error;
          process.exit(result.status ?? 1);
        `,
          { mode: 0o755 },
        );
      }
      // Apply the supported separate-Node layout to the actual Vitest suite and
      // every nested worker, while keeping PATH restricted to these fixture tools.
      const preload = path.join(root, 'separate-node.mjs');
      writeFileSync(
        preload,
        `process.execPath = ${JSON.stringify(separateNode)};`,
      );
      const env = {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`,
        PATH: tools,
        TMPDIR: root,
        npm_execpath: '',
        COREPACK_ENABLE_NETWORK: '0',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      };
      const discovery = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import {packageManagerEntry} from ${JSON.stringify(pathToFileURL(path.resolve('scripts/lib/package-manager-entry.mjs')).href)};
        if (packageManagerEntry('pnpm') !== undefined) throw new Error('unexpected discoverable pnpm JS launcher');
        console.log('no-pnpm-js-launcher');
      `,
        ],
        { encoding: 'utf8', env },
      );
      expect(discovery.status, discovery.stdout + discovery.stderr).toBe(0);
      expect(discovery.stdout.trim()).toBe('no-pnpm-js-launcher');
      const result = spawnSync(
        process.execPath,
        [
          path.resolve('node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          'scripts/vitest.config.ts',
          'scripts/package-manager-fixture.test.ts',
        ],
        { encoding: 'utf8', timeout: 25000, env },
      );
      expect(result.status, result.stdout + result.stderr).toBe(
        available ? 0 : 1,
      );
      if (available) {
        expect(result.stdout).toMatch(/2 passed/);
        const calls: string[][] = readFileSync(argvLog, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const packs = calls.filter((args) => args[0] === 'pack');
        expect(packs).toHaveLength(2);
        for (const args of packs) {
          expect(args).toHaveLength(3);
          expect(args[1]).toBe('--pack-destination');
          expect(args[2]).toContain('am compatibility & spaces-');
        }
      } else {
        expect(result.stdout + result.stderr).toMatch(
          /real npm and pnpm are required|spawnSync pnpm ENOENT/,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
