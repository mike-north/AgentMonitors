/** Packing and installed-file lookup shared by isolated consumer checks. */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { packageManagerEntry } from './package-manager-entry.mjs';

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
  // Only pnpm rewrites workspace dependencies into consumer-installable versions.
  const entry = packageManagerEntry('pnpm');
  const useEntry = entry !== undefined;
  if (!useEntry && process.platform === 'win32') {
    throw new Error(
      'On Windows, run via pnpm so its JavaScript entrypoint is available.',
    );
  }
  const command = useEntry ? process.execPath : 'pnpm';
  const args = [
    ...(useEntry ? [entry] : []),
    'pack',
    '--pack-destination',
    packDestDir,
  ];
  const before = new Set(readdirSync(packDestDir));
  const result = spawnSync(command, args, {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    if (typeof result.stderr === 'string' && result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    const errorMessageParts = [
      `Command failed (${String(result.status ?? 'unknown')}): ${command} pack --pack-destination ${packDestDir} (cwd: ${packageDir})`,
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

/**
 * Resolve a file inside a globally-`npm install`ed package, given the
 * `--prefix` directory the install used. npm's global layout nests installed
 * packages differently by platform: `<prefix>/lib/node_modules/<pkg>/...` on
 * POSIX, but `<prefix>/node_modules/<pkg>/...` on Windows (no `lib/`
 * component). Shared by `scripts/test-e2e-fresh-install-hooks.mjs` and
 * `scripts/test-windows-install.mjs` so both resolve an installed package's
 * files identically instead of re-deriving this platform difference.
 *
 * @param {string} prefixDir
 * @param {string} packageName
 * @param {...string} relativeParts
 * @returns {string}
 */
export function resolveInstalledPackageFile(
  prefixDir,
  packageName,
  ...relativeParts
) {
  const nodeModulesDir =
    process.platform === 'win32'
      ? path.join(prefixDir, 'node_modules')
      : path.join(prefixDir, 'lib', 'node_modules');
  return path.join(nodeModulesDir, packageName, ...relativeParts);
}
