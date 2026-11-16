/**
 * Parent-side capture and adopted-watchdog cleanup share one lazy native binding
 * and libc handle. Disposable exec launchers load their own binding in their own
 * processes; this cache never changes admission paths or authored environments.
 */
import { createRequire } from 'node:module';

import { vendoredNativeLoader } from './native-binding.js';

/** Scalar-returning process operations use only scalar arguments and owned buffers. @internal */
export interface INativeProcessLibrary {
  readonly errno: () => number;
  readonly func: (
    declaration: string,
  ) => (...args: (number | string | Buffer)[]) => number;
}

/** Resource capture and reaping resolve symbols separately on this same process-local handle. */
let shared: INativeProcessLibrary | undefined;

/** Inert imports do not initialize an addon, and failed initialization publishes no cache. @internal */
export function nativeProcessLibrary(): INativeProcessLibrary {
  if (shared !== undefined) return shared;
  const filename = vendoredNativeLoader();
  // The packaged CommonJS API is outside TypeScript; only the narrow scalar /
  // pointer declarations required by parent process operations are described.
  const koffi = createRequire(filename)(filename) as {
    errno: () => number;
    load: (filename: null) => { func: INativeProcessLibrary['func'] };
  };
  const library = koffi.load(null);
  shared = {
    errno: koffi.errno,
    func: (declaration) => library.func(declaration),
  };
  return shared;
}
