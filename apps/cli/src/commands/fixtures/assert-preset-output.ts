/** Test-only boundary validation before preset stdout reaches JSON.parse. */
/** @internal */
export function assertPresetOutput(
  _command: unknown,
  exitCode: string,
  stderr: string | Buffer,
  stdout: string,
  truncated: boolean,
  stderrTruncated = false,
): void {
  if (exitCode !== '0' || !stdout.trim() || truncated) {
    const bytes = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr);
    // Arbitrary argv/filter/stderr may contain input data. Only fixed categories
    // and scalar status metadata cross this test's diagnostic boundary.
    const tail = bytes.subarray(-4096).toString('utf8');
    const category = !bytes.length
      ? '(empty)'
      : /compile error|syntax error/.test(tail)
        ? 'jq compile error (check filter syntax)'
        : 'content withheld (inspect synthetic fixture and filter locally)';
    const cutoff = stderrTruncated || bytes.length > 4096;
    // command is deliberately never formatted: even argv[0] can be private input.
    throw new Error(
      `Preset jq command failed\ncontext: preset subprocess; argv withheld\nexit code: ${/^(?:0|[1-9]\d{0,2})$/.test(exitCode) && Number(exitCode) <= 255 ? exitCode : 'unavailable'}\nstderr: ${category}\nstderr empty: ${String(bytes.length === 0)}; retained bytes: ${String(Math.min(bytes.length, 4096))}; stderr truncated: ${String(cutoff)}\nstdout empty: ${String(!stdout.trim())}; truncated: ${String(truncated)}`,
    );
  }
}
