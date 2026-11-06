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

it.skipIf(process.platform === 'win32')(
  'runs the actual compatibility suite with separate Node/npm installations',
  () => {
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
      if (!npm || !pnpm)
        throw new Error(
          'real npm and pnpm are required for compatibility fixtures',
        );
      symlinkSync(npm, path.join(toolsDir, 'npm'));
      symlinkSync(pnpm, path.join(toolsDir, 'pnpm'));
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
