/** Unsupported or damaged native support refuses authored work and preserves its baseline. */
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import source from './index.js';

const fixture = vi.hoisted(() => ({ native: '' }));
vi.mock('./native-binding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./native-binding.js')>();
  return {
    ...actual,
    vendoredNativeLoader: () => fixture.native || actual.vendoredNativeLoader(),
  };
});
afterEach(() => {
  fixture.native = '';
  vi.unstubAllGlobals();
});

describe('native admission failures', () => {
  it.each(['win32', 'freebsd'])(
    'refuses %s without a plain-spawn fallback',
    async (platform) => {
      const marker = path.join(mkdtempSync(path.join(tmpdir(), 'kb-')), 'ran');
      const command = [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      ];
      vi.stubGlobal(
        'process',
        new Proxy(process, {
          get(target, key) {
            return key === 'platform' ? platform : Reflect.get(target, key);
          },
        }),
      );
      const result = await source.observe({ command }, { now: new Date() });
      expect(existsSync(marker)).toBe(false);
      expect(result.nextState).toMatchObject({ health: 'failing' });
      expect(result.observations[0]?.payload).toMatchObject({
        error: expect.stringContaining(platform),
      });
    },
  );
  it.each(['missing', 'corrupt'])(
    'refuses a %s binding without replacing baseline',
    async (fault) => {
      // A launcher loads this isolated fixture instead of touching committed native bytes.
      const dir = mkdtempSync(path.join(tmpdir(), 'kb-'));
      const marker = path.join(dir, 'ran');
      fixture.native = path.join(dir, 'load.cjs');
      writeFileSync(
        fixture.native,
        readFileSync(new URL('../vendor/koffi/load.cjs', import.meta.url)),
      );
      const binary = path.join(
        dir,
        `${process.platform}-${process.arch}`,
        'koffi.node',
      );
      mkdirSync(path.dirname(binary), { recursive: true });
      if (fault === 'corrupt') writeFileSync(binary, 'invalid native bytes');
      const previousState = {
        stdout: 'baseline',
        exitCode: 0,
        truncated: false,
        health: 'ok',
        baselined: true,
      };
      const result = await source.observe(
        {
          command: [
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
          ],
          timeout: '2s',
        },
        { now: new Date(), previousState },
      );
      expect(existsSync(marker)).toBe(false);
      expect(result.nextState).toEqual({ ...previousState, health: 'failing' });
      expect(result.observations[0]?.payload).toMatchObject({
        error: expect.stringContaining(`${process.platform}-${process.arch}`),
      });
    },
  );
});
