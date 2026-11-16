/**
 * Test-only FIFO drain: retain the last 4 KiB and total byte count before the
 * parent reads either file. Synchronous reads in this dedicated child handle
 * empty FIFO EOF reliably without event-loop readiness races on macOS.
 */
import { readSync, writeFileSync } from 'node:fs';
const [stderrPath, totalPath] = process.argv.slice(2);
if (!stderrPath || !totalPath) throw new Error('Missing capture output paths');
const limit = 4096;
const chunk = Buffer.alloc(64 * 1024);
let tail = Buffer.alloc(0);
let totalBytes = 0;
for (;;) {
  const count = readSync(0, chunk, 0, chunk.length, null);
  if (!count) break;
  totalBytes += count;
  // Copy only the retained suffix; incoming buffers never accumulate.
  tail = Buffer.from(
    Buffer.concat([tail, chunk.subarray(0, count)]).subarray(-limit),
  );
}
writeFileSync(stderrPath, tail);
writeFileSync(totalPath, String(totalBytes));
