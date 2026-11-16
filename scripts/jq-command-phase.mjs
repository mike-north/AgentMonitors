/**
 * Timing and verdict contract for negative jq facility controls only. Startup
 * cannot consume the command/report allowance, and a late startup receipt cannot
 * erase a startup failure. Neither allowance changes jq's own execution budget.
 */

// The command/report allowance and enclosing 7s test remain unchanged. Startup
// gets its own 7s window in a 10s setup hook, reserving 1s for owned cleanup and
// 2s for framework scheduling. Import latency never spends the command window.
const NEGATIVE_PHASE_ALLOWANCE = 4_000 + 1_000;
const STARTUP_ALLOWANCE = 7_000;

/**
 * @param {number} started - Parent's driver launch timestamp.
 * @param {number | undefined} phaseStarted - Selected fake-jq phase's immutable receipt.
 * @param {number} now - Current time, used only while waiting for startup.
 * @returns {number} Absolute startup or command/report deadline.
 * @internal
 */
export function negativeJqPhaseDeadline(started, phaseStarted, now) {
  const startupElapsed = (phaseStarted ?? now) - started;
  if (startupElapsed >= STARTUP_ALLOWANCE) {
    throw new Error(
      `Negative jq driver startup deadline expired (elapsed ${startupElapsed}ms; allowance ${STARTUP_ALLOWANCE}ms)`,
    );
  }
  return phaseStarted === undefined
    ? started + STARTUP_ALLOWANCE
    : phaseStarted + NEGATIVE_PHASE_ALLOWANCE;
}

/**
 * A generic timeout is insufficient evidence: the real jq helper must report
 * its existing one-second command budget, even after slow framework startup.
 * @param {string} message - Failure text from the complete intended phase report.
 * @internal
 */
export function assertJqCommandBudget(message) {
  if (!message.includes('jq command deadline expired (1000ms)')) {
    throw new Error(
      'Expected the unchanged 1000ms jq command deadline failure',
    );
  }
}
