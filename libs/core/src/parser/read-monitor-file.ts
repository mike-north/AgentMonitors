/**
 * Bounded monitor-file intake shared by synchronous callers and asynchronous
 * discovery. One read budget governs both paths before any UTF-8 decoding.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { MAX_MONITOR_BYTES } from '../schema/input-limits.js';

/**
 * Yield only unused capacity within a fixed byte budget. Drivers supply
 * actual byte counts, so partial reads and file growth cannot exceed the limit
 * plus one detection byte. Undefined denotes oversized input; empty files
 * return an empty string. Oversized content is never decoded.
 */
function* monitorReadBudget(): Generator<Buffer, string | undefined, number> {
  const capacityLimit = MAX_MONITOR_BYTES + 1;
  // Scans open files concurrently. Small monitors should not each reserve the
  // entire maximum; grow only when bytes already read fill the current buffer.
  let bytes = Buffer.alloc(Math.min(4096, capacityLimit));
  let size = 0;
  while (size < capacityLimit) {
    if (size === bytes.length) {
      const grown = Buffer.alloc(Math.min(bytes.length * 2, capacityLimit));
      bytes.copy(grown, 0, 0, size);
      bytes = grown;
    }
    const count = yield bytes.subarray(size);
    if (count === 0) {
      break;
    }
    size += count;
  }
  return size > MAX_MONITOR_BYTES
    ? undefined
    : bytes.subarray(0, size).toString('utf8');
}

/**
 * Read monitor content without parsing, using the same admission budget as
 * discovery and direct parsing. Diagnostic consumers must retain this boundary
 * even when a file grows or is replaced after discovery.
 *
 * @returns UTF-8 content for files at or below the monitor byte limit, or
 * undefined for oversized input, which is never decoded. The descriptor closes
 * on success, rejection, or failure; filesystem errors propagate to the caller.
 * @public
 */
export function readMonitorFileSync(filePath: string): string | undefined {
  const fd = openSync(filePath, 'r');
  try {
    const budget = monitorReadBudget();
    let step = budget.next();
    while (!step.done) {
      step = budget.next(readSync(fd, step.value, 0, step.value.length, null));
    }
    return step.value;
  } finally {
    closeSync(fd);
  }
}

/**
 * Asynchronous driver for the same read budget. Discovery retains asynchronous
 * filesystem I/O rather than blocking the daemon's event loop on each file.
 * @internal
 */
export async function readMonitorFile(
  filePath: string,
): Promise<string | undefined> {
  const file = await open(filePath, 'r');
  try {
    const budget = monitorReadBudget();
    let step = budget.next();
    while (!step.done) {
      const { bytesRead } = await file.read(
        step.value,
        0,
        step.value.length,
        null,
      );
      step = budget.next(bytesRead);
    }
    return step.value;
  } finally {
    await file.close();
  }
}
