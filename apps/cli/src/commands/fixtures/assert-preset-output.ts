/** Test-only boundary validation before preset stdout reaches JSON.parse. */
/** @internal */
export function assertPresetOutput(
  command: unknown,
  exitCode: string,
  stderr: string,
  stdout: string,
  truncated: boolean,
): void {
  if (exitCode !== '0' || !stdout.trim() || truncated) {
    throw new Error(
      `Preset jq command failed: ${JSON.stringify(Array.isArray(command) ? [command[0], '[arguments redacted]'] : '[command redacted]')}\nexit code: ${exitCode || 'unavailable'}\nstderr: ${stderr ? `[content redacted; ${String(Buffer.byteLength(stderr))} captured bytes]` : '(empty)'}\nstdout empty: ${String(!stdout.trim())}; truncated: ${String(truncated)}`,
    );
  }
}
