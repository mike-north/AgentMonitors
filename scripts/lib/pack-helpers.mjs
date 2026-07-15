import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/**
 * Pack one workspace package with `pnpm pack`, resolving the tarball it
 * produced by diffing `packDestDir`'s contents before and after — `pnpm
 * pack`'s own stdout format for the produced filename is not something we
 * want to depend on parsing. Throws with the command's stderr surfaced (and
 * echoed to this process's stderr) on failure.
 *
 * Shared by `scripts/test-standalone-consumer.mjs` and
 * `scripts/test-e2e-fresh-install-hooks.mjs` so both stay byte-for-byte
 * consistent in how they resolve a packed tarball path — this was
 * previously a verbatim copy maintained in both files.
 */
export function packPackage(packageDir, packDestDir) {
  const before = new Set(readdirSync(packDestDir));
  const result = spawnSync(
    PNPM_BIN,
    ['pack', '--pack-destination', packDestDir],
    {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    if (typeof result.stderr === 'string' && result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    const errorMessageParts = [
      `Command failed (${String(result.status ?? 'unknown')}): ${PNPM_BIN} pack --pack-destination ${packDestDir} (cwd: ${packageDir})`,
    ];
    if (result.error?.message) {
      errorMessageParts.push(`Spawn error: ${result.error.message}`);
    }
    throw new Error(errorMessageParts.join('\n'));
  }

  const after = readdirSync(packDestDir);
  const created = after.find(
    (entry) => !before.has(entry) && entry.endsWith('.tgz'),
  );

  if (!created) {
    throw new Error(
      `Could not determine packed tarball for ${packageDir}. pnpm output: ${(result.stdout ?? '').trim()}`,
    );
  }

  return path.join(packDestDir, created);
}
