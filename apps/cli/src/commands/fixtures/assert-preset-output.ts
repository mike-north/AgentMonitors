/** Test-only boundary validation before preset stdout reaches JSON.parse. */
/** @internal */
export function assertPresetOutput(
  command: unknown,
  exitCode: string,
  stderr: string,
  stdout: string,
  truncated: boolean,
  stderrTruncated = false,
): void {
  if (exitCode !== '0' || !stdout.trim() || truncated) {
    const bytes = Buffer.from(stderr);
    const retained = bytes.subarray(0, 4096).toString('utf8');
    const cutoff = stderrTruncated || bytes.length > 4096;
    throw new Error(
      `Preset jq command failed: ${JSON.stringify(command)}\nexit code: ${exitCode || 'unavailable'}\nstderr: ${retained || '(empty)'}${cutoff ? '\n[stderr truncated at 4096 bytes]' : ''}\nstdout empty: ${String(!stdout.trim())}; truncated: ${String(truncated)}`,
    );
  }
}
