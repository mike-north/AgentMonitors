/** Resolve packaged native admission beside our own module in source, ESM, CJS and the CLI bundle. */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Both published entry points live in dist/, with the payload in ../vendor/koffi. @internal */
export function vendoredNativeLoader(): string {
  // ESM callers can expose a foreign __filename. Prefer our own URL when present;
  // tsup's CommonJS bundle uses its own filename in place of import.meta.url.
  const filename = import.meta.url
    ? fileURLToPath(import.meta.url)
    : __filename;
  return path.resolve(path.dirname(filename), '../vendor/koffi/load.cjs');
}
