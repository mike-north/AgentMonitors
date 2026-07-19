import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read the CLI's version from its own `package.json`. Both the TS source
 * (`src/*.ts`) and the bundled artifact (`dist/index.cjs`) sit one level below
 * the package root, so a single `..` resolves the manifest in either layout.
 * (tsup's `shims: true` provides `import.meta.url` in the CJS bundle.)
 *
 * Never hardcode a version literal against this: a stale literal silently
 * drifts from the real release, which makes both `--version` and the
 * transport heartbeat's `version` field useless for diagnosing a user's
 * install — the exact question `doctor`'s transport rows exist to answer
 * ("which CLI is actually serving this session?").
 */
export function getCliVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(dir, '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
