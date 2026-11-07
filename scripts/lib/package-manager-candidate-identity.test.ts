/** Every nominal installation candidate must identify the requested physical manager. */
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

import { afterEach, describe, expect, it } from 'vitest';

/** Disposable physical files make manager identity observable through execution. */
const roots: string[] = [];
const node = process.execPath;
const resolver = pathToFileURL(
  path.resolve('scripts/lib/package-manager-entry.mjs'),
).href;
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** The output identifies the actual executed file, not its nominal installation name. */
function launcher(file: string, manager: string, position: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `console.log(JSON.stringify({manager:${JSON.stringify(manager)}, position:${JSON.stringify(position)}, argv:process.argv.slice(2)}));`,
  );
}

describe.skipIf(process.platform === 'win32').each(['official', 'adjacent'])(
  '%s candidate physical identity',
  (layout) => {
    describe.each(['npm', 'pnpm'])('requested %s', (manager) => {
      it.each([
        'wrong then valid',
        'wrong only',
        'valid standalone',
        'valid Corepack',
      ])('executes only the requested manager (%s)', (scenario) => {
        const root = realpathSync.native(
          mkdtempSync(
            path.join(os.tmpdir(), 'am candidate identity & spaces-'),
          ),
        );
        roots.push(root);
        const nodeDir = path.join(root, 'node/bin');
        const firstTools = path.join(root, 'first-tools');
        const laterTools = path.join(root, 'later-tools');
        const childCwd = path.join(root, 'packed child');
        for (const dir of [nodeDir, firstTools, laterTools, childCwd])
          mkdirSync(dir, { recursive: true });
        const filename = manager === 'npm' ? 'npm-cli.js' : 'pnpm.cjs';
        const modules = path.join(
          layout === 'official' ? nodeDir : firstTools,
          'node_modules',
        );
        const candidate = path.join(modules, manager, 'bin', filename);
        const wrong = scenario.startsWith('wrong');
        const physicalManager = wrong
          ? manager === 'npm'
            ? 'pnpm'
            : 'npm'
          : manager;
        const target =
          scenario === 'valid standalone'
            ? path.join(root, 'targets', manager, 'bin', filename)
            : path.join(root, 'targets/corepack/dist', `${physicalManager}.js`);
        launcher(target, physicalManager, 'candidate');
        mkdirSync(path.dirname(candidate), { recursive: true });
        symlinkSync(target, candidate);
        writeFileSync(
          path.join(firstTools, `${manager}.cmd`),
          '@echo never execute this shim',
        );
        const later = path.join(root, 'later', manager, 'bin', filename);
        if (scenario !== 'wrong only') {
          launcher(later, manager, 'later');
          symlinkSync(later, path.join(laterTools, manager));
        }
        const expected =
          scenario === 'wrong only' ? undefined : wrong ? later : target;
        const probe = spawnSync(
          node,
          [
            '--input-type=module',
            '-e',
            `
            import {spawnSync} from 'node:child_process';
            import {packageManagerEntry} from ${JSON.stringify(resolver)};
            process.execPath = ${JSON.stringify(path.join(nodeDir, 'node.exe'))};
            Object.defineProperty(process, 'platform', {value:'win32'});
            const selected = packageManagerEntry(${JSON.stringify(manager)});
            const run = selected && spawnSync(${JSON.stringify(node)}, [selected, 'literal & spaces'], {cwd:${JSON.stringify(childCwd)}, encoding:'utf8'});
            console.log(JSON.stringify({selected, status:run?.status, stdout:run?.stdout, stderr:run?.stderr}));
          `,
          ],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              npm_execpath: '',
              PATH: firstTools + path.delimiter + laterTools,
            },
          },
        );
        expect(probe.status, probe.stderr).toBe(0);
        const result = JSON.parse(probe.stdout);
        if (expected === undefined) {
          expect(result.selected, result.stdout).toBeUndefined();
        } else {
          expect(result.status, result.stderr).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual({
            manager,
            position: wrong ? 'later' : 'candidate',
            argv: ['literal & spaces'],
          });
          expect(result.selected).toBe(expected);
        }
      });
    });
  },
);
