/** Native selection is explicit and refuses unsupported ABIs without searching elsewhere. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const loader = readFileSync(
  new URL('./lib/koffi-loader.cjs', import.meta.url),
  'utf8',
);
/** Observe every require: only the selected binary and explicit wrapper may load. */
function load(
  platform: string,
  arch: string,
  glibc?: string,
  failure?: string,
) {
  const requests: string[] = [];
  const native = { version: '3.3.7' };
  const module = { exports: {} };
  runInNewContext(loader, {
    __dirname: '/package/vendor/koffi',
    module,
    process: {
      platform,
      arch,
      report: { getReport: () => ({ header: { glibcVersionRuntime: glibc } }) },
    },
    require: (id: string) => {
      requests.push(id);
      if (id === 'node:path') return path;
      if (id.endsWith('.node')) {
        if (failure) throw new Error(failure);
        return native;
      }
      if (id === './wrapper.cjs') return (value: unknown) => value;
      throw new Error(`Unexpected resolution: ${id}`);
    },
  });
  return { module, requests, native };
}
describe('packaged native selection', () => {
  it.each(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])(
    'selects only the vendored %s prebuild',
    (platform) => {
      const [os, arch] = platform.split('-');
      const result = load(os, arch, '2.31');
      expect(result.module.exports).toBe(result.native);
      expect(result.requests).toEqual([
        'node:path',
        `/package/vendor/koffi/${platform}/koffi.node`,
        './wrapper.cjs',
      ]);
    },
  );
  it.each([
    ['win32', 'x64', undefined],
    ['darwin', 'ppc64', undefined],
    ['linux', 'x64', undefined],
    ['freebsd', 'arm64', undefined],
  ])('refuses %s-%s without native fallback', (platform, arch, glibc) => {
    expect(() => load(platform, arch, glibc)).toThrow(`${platform}-${arch}`);
  });
  it.each(['missing binary', 'corrupt binary'])(
    'names the platform after %s failure',
    (failure) => {
      expect(() => load('linux', 'arm64', '2.31', failure)).toThrow(
        `Native exec support for linux-arm64 could not be loaded: ${failure}`,
      );
    },
  );
});
