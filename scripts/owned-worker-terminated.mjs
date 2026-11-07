/**
 * Test-only liveness evidence for an owned worker after process-group cleanup.
 * Linux PID 1 may retain terminated orphans as zombies: PID existence alone
 * does not mean executable work survived. Never hide permission or proc errors.
 */
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';

/**
 * @param {number} pid - PID captured from this test's owned worker.
 * @returns {boolean} True only for ESRCH or a proven Linux zombie/dead state.
 * @internal
 */
export function ownedWorkerTerminated(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return true;
    throw error;
  }
  if (platform() !== 'linux') return false;
  let status;
  try {
    status = readFileSync(`/proc/${pid}/status`, 'utf8');
  } catch (error) {
    // Disappearance between the signal probe and proc read is success only
    // when a fresh signal probe confirms ESRCH, never merely a missing file.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      try {
        process.kill(pid, 0);
      } catch (probeError) {
        if (
          probeError instanceof Error &&
          'code' in probeError &&
          probeError.code === 'ESRCH'
        )
          return true;
        throw probeError;
      }
    }
    throw error;
  }
  const state = /^State:\s+([A-Za-z])\b/m.exec(status)?.[1];
  if (!state)
    throw new Error(`No recognizable process state for owned worker ${pid}`);
  return state === 'Z' || state === 'X' || state === 'x';
}
