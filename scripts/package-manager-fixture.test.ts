/** Run the committed compatibility suite with tools genuinely outside Node's directory. */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';

import { packageManagerEntry } from './lib/package-manager-entry.mjs';

it
  .skipIf(process.platform === 'win32')
  .each(['real npm', 'Corepack context proxy'])(
  'runs the actual compatibility suite with separate Node/npm installations (%s)',
  (layout) => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), 'am actual suite & spaces-'),
    );
    try {
      const nodeDir = path.join(root, 'node-only');
      const toolsDir = path.join(root, 'tools');
      mkdirSync(nodeDir, { recursive: true });
      mkdirSync(toolsDir, { recursive: true });
      const npm = packageManagerEntry('npm');
      const pnpm = packageManagerEntry('pnpm');
      if (!npm)
        throw new Error('real npm is required for compatibility fixtures');
      const selectedNpm =
        layout === 'Corepack context proxy'
          ? path.join(root, 'node_modules/corepack/dist/npm.js')
          : npm;
      if (layout === 'Corepack context proxy') {
        mkdirSync(path.dirname(selectedNpm), { recursive: true });
        // Model Corepack's context-sensitive dispatch without a global Corepack
        // installation or downloads, then execute the actual installed npm CLI.
        writeFileSync(
          selectedNpm,
          `
          const path = require('node:path');
          const {spawnSync} = require('node:child_process');
          const {realpathSync} = require('node:fs');
          const installRoot = path.dirname(process.cwd());
          if (path.basename(process.cwd()) !== 'packed') {
            throw new Error('npm probe lost install cwd');
          }
          // Canonicalize parent directories for macOS /var versus /private/var aliases.
          const matchesInstallPath = (value, basename) => typeof value === 'string' &&
            realpathSync(path.dirname(value)) === installRoot && path.basename(value) === basename;
          if (!matchesInstallPath(process.env.NODE_GYP_FORCE_PYTHON, 'deliberately-missing-python-so-node-gyp-fails.exe') ||
              !matchesInstallPath(process.env.npm_config_cache, 'npm-cache') ||
              !matchesInstallPath(process.env.HOME, 'home')) {
            throw new Error('npm probe lost install env');
          }
          const result = spawnSync(process.execPath, [${JSON.stringify(npm)}, ...process.argv.slice(2)], {encoding:'utf8', env:process.env});
          if (result.error) throw result.error;
          process.stdout.write(result.stdout);
          process.stderr.write(result.stderr);
          process.exit(result.status ?? 1);
        `,
        );
      }
      symlinkSync(selectedNpm, path.join(toolsDir, 'npm'));
      // POSIX packing also supports executable-only pnpm. When JS discovery is
      // absent, retain inherited PATH so the real suite exercises that fallback.
      if (pnpm) symlinkSync(pnpm, path.join(toolsDir, 'pnpm'));
      const separateNode = path.join(nodeDir, 'node');
      symlinkSync(process.execPath, separateNode);
      // Preload applies to Vitest and its workers, so the actual committed helper
      // and subprocess tests see the same supported separate-install environment.
      const preload = path.join(root, 'separate-node.mjs');
      writeFileSync(
        preload,
        `process.execPath = ${JSON.stringify(separateNode)};`,
      );
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(preload).href,
          path.resolve('node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          'scripts/vitest.config.ts',
          'scripts/package-manager-compatibility.test.ts',
        ],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`,
            PATH: toolsDir + path.delimiter + (process.env.PATH ?? ''),
            TMPDIR: root,
            npm_execpath: '',
            COREPACK_ENABLE_NETWORK: '0',
            NO_COLOR: '1',
            FORCE_COLOR: '0',
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toMatch(/2 passed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  25000,
);
