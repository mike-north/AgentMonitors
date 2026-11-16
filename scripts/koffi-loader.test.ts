/** Native selection refuses uncertain Linux ABIs before any native initializer can run. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const loader = readFileSync(
  new URL('./lib/koffi-loader.cjs', import.meta.url),
  'utf8',
);
/** Representative kernel records keep admission tied to mapped filenames, not substrings. */
function mapping(filename: string): string {
  return `7f000000-7f001000 r-xp 00000000 08:01 123 ${filename}\n`;
}
const glibcMaps = mapping('/usr/lib/x86_64-linux-gnu/libc.so.6');

/** Kernel-generated names describe memory objects, even when caller labels resemble libc. */
const syntheticNames = [
  '/memfd:cache/libc.so.6',
  '/memfd:cache/libc.so.6 (deleted)',
  '/memfd:cache/ld-musl-x86_64.so.1 (deleted)',
  '/dmabuf:cache/libc.so.6',
  '/dmabuf:cache/ld-musl-x86_64.so.1',
  'anon_inode:cache/libc.so.6',
  'anon_inode:cache/libc.musl-x86_64.so.1',
  '[anon:cache/libc.so.6]',
  '[anon:cache/libc.musl-x86_64.so.1]',
  '[anon_shmem:cache/libc.so.6]',
  '[anon_shmem:cache/libc.musl-x86_64.so.1]',
  '/SYSV00000000 (deleted)',
  '/dev/zero (deleted)',
  '/anon_hugepage (deleted)',
  '/[aio] (deleted)',
  '/secretmem (deleted)',
  '[heap]',
  '[stack]',
  '[vdso]',
  '[vvar]',
  'libc.so.6',
  'relative/libc.so.6',
  'relative/ld-musl-x86_64.so.1',
  '',
];

/** VM-only evidence injection exposes ordering without adding a production override. */
function load(
  platform: string,
  arch: string,
  maps: string | Error = glibcMaps,
  failure?: string,
  glibc = true,
) {
  const requests: string[] = [];
  const reads: string[] = [];
  const reports: string[] = [];
  const native = {
    version: '3.3.7',
    load: () => ({
      func: () => {
        if (!glibc) {
          throw new Error('missing gnu_get_libc_version');
        }
        return () => '2.31';
      },
    }),
  };
  const module = { exports: {} };
  let error: unknown;
  try {
    runInNewContext(loader, {
      __dirname: '/package/vendor/koffi',
      module,
      process: {
        platform,
        arch,
        // Even looking up the diagnostic facility violates admission's bounded-work contract.
        get report() {
          reports.push('report');
          throw new Error('Diagnostic capture is forbidden');
        },
      },
      require: (id: string) => {
        requests.push(id);
        if (id === 'node:path') return path;
        if (id === 'node:fs') {
          return {
            readFileSync: (filename: string, encoding: string) => {
              reads.push(filename);
              expect(encoding).toBe('utf8');
              if (maps instanceof Error) throw maps;
              return maps;
            },
          };
        }
        if (id.endsWith('.node')) {
          if (failure) throw new Error(failure);
          return native;
        }
        if (id === './wrapper.cjs') return (value: unknown) => value;
        throw new Error(`Unexpected resolution: ${id}`);
      },
    });
  } catch (cause) {
    error = cause;
  }
  expect(reports).toEqual([]);
  return { module, requests, reads, native, error };
}

describe('packaged native selection', () => {
  it.each(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])(
    'selects only the vendored %s prebuild without diagnostics',
    (platform) => {
      const [os, arch] = platform.split('-');
      const result = load(os, arch);
      expect(result.error).toBeUndefined();
      expect(result.module.exports).toBe(result.native);
      expect(result.requests).toEqual([
        'node:path',
        ...(os === 'linux' ? ['node:fs'] : []),
        `/package/vendor/koffi/${platform}/koffi.node`,
        './wrapper.cjs',
      ]);
      expect(result.reads).toEqual(os === 'linux' ? ['/proc/self/maps'] : []);
    },
  );
  it.each(syntheticNames)(
    'admits file-backed glibc alongside synthetic or nonabsolute name %j',
    (filename) => {
      const result = load('linux', 'x64', glibcMaps + mapping(filename));
      expect(result.error).toBeUndefined();
      expect(result.module.exports).toBe(result.native);
      expect(result.reads).toEqual(['/proc/self/maps']);
    },
  );
  it.each(syntheticNames)(
    'refuses synthetic or nonabsolute name %j as the only evidence before native loading',
    (filename) => {
      const result = load('linux', 'x64', mapping(filename));
      expect(result.requests.filter((id) => id.endsWith('.node'))).toEqual([]);
      expect(result.requests).not.toContain('./wrapper.cjs');
      expect(result.error).toMatchObject({
        message:
          'Native exec support for linux-x64 could not be loaded: glibc is required',
      });
      expect(result.reads).toEqual(['/proc/self/maps']);
    },
  );
  // Overlay filesystems can use anonymous device numbers for ordinary mapped files.
  it('admits file-backed glibc on an anonymous device', () => {
    const result = load('linux', 'x64', glibcMaps.replace('08:01', '00:42'));
    expect(result.error).toBeUndefined();
    expect(result.module.exports).toBe(result.native);
  });
  // Synthetic-looking components below a real directory do not name kernel objects.
  it.each([
    '/usr/lib/memfd:cache',
    '/usr/lib/dmabuf:cache',
    '/usr/lib/SYSV00000000',
    '/usr/lib/anon_hugepage',
    '/[lib]',
  ])('keeps real file evidence under directory %s', (directory) => {
    expect(
      load('linux', 'x64', mapping(`${directory}/libc.so.6`)).error,
    ).toBeUndefined();
    const result = load(
      'linux',
      'x64',
      glibcMaps + mapping(`${directory}/ld-musl-x86_64.so.1`),
    );
    expect(result.error).toMatchObject({
      message: expect.stringContaining('glibc is required'),
    });
    expect(result.requests.filter((id) => id.endsWith('.node'))).toEqual([]);
  });
  it.each(['x64', 'arm64'])('accepts older glibc naming on %s', (arch) => {
    const result = load('linux', arch, mapping('/lib/libc-2.31.so'));
    expect(result.error).toBeUndefined();
    expect(result.module.exports).toBe(result.native);
    expect(result.reads).toEqual(['/proc/self/maps']);
  });
  it('accepts a mapped glibc file retained after deletion', () => {
    expect(
      load('linux', 'x64', mapping('/lib/libc.so.6 (deleted)')).error,
    ).toBeUndefined();
  });
  // Kernel records use LF alone as their delimiter; these characters remain in file paths.
  it.each(['\r', '\u2028', '\u2029'])(
    'admits glibc alongside a legal pathname containing %j',
    (separator) => {
      const result = load(
        'linux',
        'x64',
        glibcMaps + mapping(`/tmp/a${separator}b/addon.so`),
      );
      expect(result.error).toBeUndefined();
      expect(result.module.exports).toBe(result.native);
    },
  );
  // Valid unrelated mappings must not turn positive libc evidence into a format refusal.
  it.each([
    ['pathless anonymous', '7f000000-7f001000 rw-p 00000000 00:00 0\n'],
    ['padded pathless anonymous', mapping('')],
    ...[
      '[heap]',
      '[stack]',
      '[vdso]',
      '[vvar]',
      '[vsyscall]',
      '[anon:v8 shared memory]',
      '[anon_shmem:arena 1]',
      '/memfd:v8 code pages (deleted)',
      '/tmp/with spaces/addon.so',
      '/tmp/with\ttabs/addon.so',
      '/tmp/escaped\\012lf/addon.so',
      '/tmp/addon.so (deleted)',
    ].map((filename) => [filename, mapping(filename)]),
    ['long pathname', mapping(`/tmp/${'a/'.repeat(2040)}addon.so`)],
    [
      'wide fields',
      'ffffffffff600000-ffffffffff601000 --xp ffffffffffffffff fff:fffff 18446744073709551615 /tmp/addon.so\n',
    ],
    [
      'zero fields and padded pathname',
      '00000000-00001000 rw-s 00000000 00:00 0                  /tmp/addon.so\n',
    ],
  ])('admits glibc alongside %s', (_name, record) => {
    const result = load('linux', 'x64', glibcMaps + record);
    expect(result.error).toBeUndefined();
    expect(result.module.exports).toBe(result.native);
  });
  // Musl evidence dominates a normal glibc mapping even when its basename retains
  // legal non-LF separators; refusal must precede every native initializer.
  it.each(
    ['\r', '\u2028', '\u2029'].flatMap((separator) => [
      [
        `libc suffix ${JSON.stringify(separator)}`,
        `/lib/libc.musl-x86_64.so.1${separator}`,
      ],
      [
        `libc interior ${JSON.stringify(separator)}`,
        `/lib/libc.musl-x86${separator}_64.so.1`,
      ],
      [
        `loader wildcard ${JSON.stringify(separator)}`,
        `/lib/ld-musl-x86${separator}_64.so.1`,
      ],
    ]),
  )(
    'refuses mixed musl evidence with %s before native loading',
    (_name, filename) => {
      const result = load('linux', 'x64', glibcMaps + mapping(filename));
      expect(result.requests.filter((id) => id.endsWith('.node'))).toEqual([]);
      expect(result.requests).not.toContain('./wrapper.cjs');
      expect(result.error).toMatchObject({
        message:
          'Native exec support for linux-x64 could not be loaded: glibc is required',
      });
    },
  );
  // Positive glibc evidence requires the entire basename, including older names.
  it.each(
    ['\r', '\u2028', '\u2029'].flatMap((separator) =>
      ['libc.so.6', 'libc-2.31.so'].map((name) => `${name}${separator}`),
    ),
  )('refuses a glibc basename with an appended separator %j', (filename) => {
    const result = load('linux', 'x64', mapping(`/lib/${filename}`));
    expect(result.requests.filter((id) => id.endsWith('.node'))).toEqual([]);
    expect(result.requests).not.toContain('./wrapper.cjs');
    expect(result.error).toMatchObject({
      message:
        'Native exec support for linux-x64 could not be loaded: glibc is required',
    });
  });
  it.each([
    ['musl loader', mapping('/lib/ld-musl-x86_64.so.1')],
    ['musl libc', mapping('/lib/libc.musl-aarch64.so.1')],
    [
      'musl compatibility layer',
      glibcMaps + mapping('/lib/ld-musl-x86_64.so.1'),
    ],
    [
      'musl libc alongside glibc',
      mapping('/lib/libc.musl-aarch64.so.1') + glibcMaps,
    ],
    [
      'deleted musl alongside glibc',
      glibcMaps + mapping('/lib/ld-musl-aarch64.so.1 (deleted)'),
    ],
    ['unreadable maps', new Error('EACCES')],
    ['empty maps', ''],
    ['unrelated maps', mapping('/usr/bin/node')],
    ['glibc directory name', mapping('/lib/libc.so.6/unrelated.so')],
    ['glibc substring', mapping('/lib/not-libc.so.6')],
    ['non-mapping text', '/lib/libc.so.6'],
    ['malformed mixed evidence', glibcMaps + '/lib/ld-musl-x86_64.so.1'],
    [
      'static Node without mapped libc',
      mapping('/usr/bin/node') + mapping('[heap]'),
    ],
  ])('refuses %s and never requires the binary', (_name, maps) => {
    const result = load('linux', 'x64', maps);
    expect(result.requests.filter((id) => id.endsWith('.node'))).toEqual([]);
    expect(result.requests).not.toContain('./wrapper.cjs');
    expect(result.error).toMatchObject({
      message:
        'Native exec support for linux-x64 could not be loaded: glibc is required',
    });
    expect(result.reads).toEqual(['/proc/self/maps']);
  });
  it.each([
    ['win32', 'x64'],
    ['darwin', 'ppc64'],
    ['linux', 'ppc64'],
    ['freebsd', 'arm64'],
  ])('refuses %s-%s without maps or native fallback', (platform, arch) => {
    const result = load(platform, arch, new Error('must not read maps'));
    expect(result.error).toMatchObject({
      message: `Native exec support for ${platform}-${arch} could not be loaded: unsupported platform`,
    });
    expect(result.reads).toEqual([]);
    expect(result.requests).toEqual(['node:path']);
  });
  it.each(['arm64', 'x64'])('never reads maps on macOS %s', (arch) => {
    const result = load('darwin', arch, new Error('must not read maps'));
    expect(result.error).toBeUndefined();
    expect(result.reads).toEqual([]);
  });
  it('retains the native symbol check after mapped glibc admission', () => {
    const result = load('linux', 'x64', glibcMaps, undefined, false);
    expect(result.error).toMatchObject({
      message:
        'Native exec support for linux-x64 could not be loaded: glibc is required',
    });
  });
  it.each(['missing binary', 'corrupt binary'])(
    'names the platform after %s failure',
    (failure) => {
      expect(load('linux', 'arm64', glibcMaps, failure).error).toMatchObject({
        message: `Native exec support for linux-arm64 could not be loaded: ${failure}`,
      });
    },
  );
});
