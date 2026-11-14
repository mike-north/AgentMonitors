/** Offline provenance checks detect changed native bytes and corrupt registry downloads. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
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
