#!/usr/bin/env node
import { Buffer } from 'node:buffer';
/**
 * Reproduce the native payload in both published packages from integrity-checked
 * npm tarballs. Only the four supported prebuilds are extracted; no lifecycle or
 * source-build script is shipped or executed. The manifest makes refresh review
 * and subsequent offline byte verification independent of registry availability.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const VERSION = '3.3.7';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

/** Reject changed downloads before parsing or extracting any payload. @internal */
export function verifyIntegrity(bytes, integrity) {
  const actual = createHash('sha512').update(bytes).digest();
  const expected = Buffer.from(integrity.replace(/^sha512-/, ''), 'base64');
  if (
    !integrity.startsWith('sha512-') ||
    expected.length !== actual.length ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new Error('Koffi tarball sha512 integrity mismatch');
  }
}

/** Used offline by repository tests; filenames make mismatches actionable. @internal */
export function verifyFile(bytes, sha256, filename) {
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error(`Koffi file sha256 mismatch: ${filename}`);
  }
}

/** Extract only named regular files from a verified archive, never archive paths on disk. */
function extract(bytes, member) {
  const tar = gunzipSync(bytes);
  const matches = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(
      header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim() || '0',
      8,
    );
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > tar.length
    )
      throw new Error('Invalid Koffi tar header');
    if (name === member) {
      if (header[156] !== 0 && header[156] !== 48)
        throw new Error(`Not a regular file: ${member}`);
      matches.push(tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (matches.length !== 1) throw new Error(`Expected exactly one ${member}`);
  return matches[0];
}

/** Upstream has no explicit-native entry point; alter only its admission/export seam. */
function explicitNativeWrapper(bytes) {
  let source = bytes.toString();
  const admission =
    'var [version, pkg, triplets] = detectPlatform2();\nvar native = loadDynamic2(__dirname, pkg, triplets);';
  const exported = 'module.exports = {';
  for (const anchor of [admission, exported]) {
    if (source.split(anchor).length !== 2)
      throw new Error(
        'Koffi indirect entry point changed; review the local shim',
      );
  }
  source = source.replace(
    admission,
    `module.exports = function(native) {\nconst version = ${JSON.stringify(VERSION)};`,
  );
  source = source.replace(exported, 'return {');
  return Buffer.from(`${source}\n};\n`);
}

/** Registry origin is fixed; redirects to another origin are not accepted. */
async function download(url) {
  if (new URL(url).origin !== 'https://registry.npmjs.org')
    throw new Error('Unexpected Koffi registry origin');
  const response = await globalThis.fetch(url, { redirect: 'error' });
  if (!response.ok)
    throw new Error(`Koffi download ${response.status}: ${url}`);
  return response;
}

/** One reviewed command refreshes identical payloads and provenance in both packages. @internal */
export async function main() {
  const files = [];
  const payload = new Map();
  for (const name of [
    'koffi',
    ...PLATFORMS.map((platform) => `@koromix/koffi-${platform}`),
  ]) {
    const metadata = await (
      await download(`https://registry.npmjs.org/${name}/${VERSION}`)
    ).json();
    if (metadata.version !== VERSION || metadata.name !== name)
      throw new Error('Unexpected Koffi metadata');
    const { tarball, integrity } = metadata.dist;
    const archive = Buffer.from(await (await download(tarball)).arrayBuffer());
    verifyIntegrity(archive, integrity);
    const selections =
      name === 'koffi'
        ? [
            ['package/src/koffi/indirect.cjs', 'wrapper.cjs'],
            ['package/LICENSE.txt', 'LICENSE.txt'],
          ]
        : [
            [
              `package/${name.slice('@koromix/koffi-'.length).replace('-', '_')}/koffi.node`,
              `${name.slice('@koromix/koffi-'.length)}/koffi.node`,
            ],
          ];
    for (const [member, filename] of selections) {
      const original = extract(archive, member);
      const bytes =
        filename === 'wrapper.cjs' ? explicitNativeWrapper(original) : original;
      payload.set(filename, bytes);
      files.push({
        path: filename,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        tarball,
        integrity,
        member,
        ...(filename === 'wrapper.cjs'
          ? {
              transformation:
                'explicit-native-factory: replace detect/load with factory input; return exports; close factory',
            }
          : {}),
      });
    }
    console.log(`Verified ${name}@${VERSION}: ${integrity}`);
  }
  const loader = readFileSync(path.join(ROOT, 'scripts/lib/koffi-loader.cjs'));
  payload.set('load.cjs', loader);
  files.push({
    path: 'load.cjs',
    sha256: createHash('sha256').update(loader).digest('hex'),
    source: 'scripts/lib/koffi-loader.cjs',
  });
  const manifest = { version: VERSION, files };
  for (const dir of ['apps/cli', 'plugins/source-command-poll']) {
    const vendor = path.join(ROOT, dir, 'vendor/koffi');
    for (const [filename, bytes] of payload) {
      mkdirSync(path.dirname(path.join(vendor, filename)), { recursive: true });
      writeFileSync(path.join(vendor, filename), bytes);
    }
    writeFileSync(
      path.join(vendor, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    console.log(
      `Wrote ${dir}/vendor/koffi (${[...payload.values()].reduce((sum, bytes) => sum + bytes.length, 0)} bytes)`,
    );
  }
}
// Compare filesystem identities even when Node preserves the main-module symlink.
// A missing argv target means this is an import, not a refresh invocation.
let isMainModule = false;
try {
  isMainModule =
    Boolean(process.argv[1]) &&
    realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1]);
} catch {
  // Importers may have an argv entry that is not a filesystem module.
}
if (isMainModule) await main();
