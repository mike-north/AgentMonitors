/** Capture only the running parent's NOFILE budget; daemon handles and workers are irrelevant. */
import { getSystemErrorMessage, getSystemErrorName } from 'node:util';

import { nativeProcessLibrary } from './native-process.js';

/** The deliberately narrow ABI used from the package's CommonJS native binding. */
interface INoFileBinding {
  readonly getrlimit: (resource: number, value: Buffer) => number;
  readonly errno: () => number;
}

/** One native function per process; each observation still reads the current parent budget. */
let binding: INoFileBinding | undefined;

/** Load lazily so unsupported hosts and inert imports never initialize a native addon. */
function nativeBinding(): INoFileBinding {
  if (binding !== undefined) return binding;
  try {
    const library = nativeProcessLibrary();
    binding = {
      getrlimit: library.func('int getrlimit(int resource, void *value)'),
      errno: library.errno,
    };
    return binding;
  } catch (error) {
    throw new Error(
      `Could not capture command RLIMIT_NOFILE: load: Native exec support for ${process.platform}-${process.arch} could not be loaded: ${String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Read the supported 64-bit POSIX struct directly, before Node helper startup
 * can raise its soft field. Decimal strings preserve every finite uint64 value
 * across the configuration pipe; platform infinity has a symbolic encoding.
 * @internal
 */
export function inheritedOpenFileLimits(): { soft: string; hard: string } {
  const native = nativeBinding();
  const value = Buffer.alloc(16);
  const nofile = process.platform === 'darwin' ? 8 : 7;
  if (native.getrlimit(nofile, value) !== 0) {
    const errno = native.errno();
    throw new Error(
      `Could not capture command RLIMIT_NOFILE: getrlimit: ${getSystemErrorName(-errno)} (${String(errno)}): ${getSystemErrorMessage(-errno)}`,
    );
  }
  // Both supported architectures are little endian and use two 64-bit fields.
  const infinity =
    process.platform === 'darwin' ? (1n << 63n) - 1n : (1n << 64n) - 1n;
  const encode = (limit: bigint): string =>
    limit === infinity ? 'unlimited' : limit.toString();
  return {
    soft: encode(value.readBigUInt64LE(0)),
    hard: encode(value.readBigUInt64LE(8)),
  };
}
