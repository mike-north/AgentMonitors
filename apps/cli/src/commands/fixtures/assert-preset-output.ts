/** Test-only boundary validation before preset stdout reaches JSON.parse. */

/** Trusted fixture context; never arbitrary argv or stderr content. @internal */
export interface IPresetDiagnosticContext {
  readonly preset?: 'my-prs' | 'pr-review';
  // Internal diagnostic hint, not a new production source outcome contract.
  readonly outcome?: 'result' | 'timeout' | 'signal' | 'source-failure';
}

/** Reject unusable output with bounded, fixed-vocabulary diagnostics. @internal */
export function assertPresetOutput(
  command: unknown,
  exitCode: string,
  stderr: string | Buffer,
  stdout: string,
  truncated: boolean,
  stderrTruncated: boolean | 'unknown' = false,
  details: IPresetDiagnosticContext = {},
): void {
  const resultKnown =
    details.outcome === undefined || details.outcome === 'result';
  const complete = resultKnown && stderrTruncated !== 'unknown';
  if (exitCode !== '0' || !stdout.trim() || truncated || !complete) {
    const bytes = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr);
    // Only exact allowlisted identities cross this boundary; argv/filter/path
    // strings and payload wording never determine emitted diagnostic text.
    const context =
      details.preset === 'my-prs' || details.preset === 'pr-review'
        ? details.preset
        : Array.isArray(command) && command[0] === 'jq'
          ? 'jq'
          : 'fixture-command';
    const status =
      /^(?:0|[1-9]\d{0,2})$/.test(exitCode) && Number(exitCode) <= 255
        ? exitCode
        : 'unavailable';
    let category = 'subprocess failed (check fixture command and exit status)';
    if (details.outcome === 'timeout')
      category = 'command timeout (check fixture duration and timeout)';
    else if (details.outcome === 'signal')
      category = 'command interrupted by signal';
    else if (details.outcome === 'source-failure')
      category = 'source failure (specific reason unavailable)';
    else if (status === '126' || status === '127')
      category = 'command unavailable (check executable, permissions and PATH)';
    else if (context === 'jq' && status === '3')
      category = 'jq compile error (check filter syntax)';
    else if (context === 'jq' && status === '5')
      category = 'jq runtime error (check input types and filter execution)';
    else if (
      (context === 'my-prs' || context === 'pr-review') &&
      status === '143'
    )
      category =
        'preset query failed (check gh authentication, repository scope and jq)';
    else if (status === '0') {
      category = !complete
        ? 'stderr capture incomplete (check reader completion)'
        : truncated
          ? 'stdout truncated (reduce fixture output)'
          : 'empty stdout (check filter output)';
    }
    // Missing completion must never be presented as silence or no cutoff.
    const metadata = complete
      ? `stderr empty: ${String(bytes.length === 0)}; retained bytes: ${String(Math.min(bytes.length, 4096))}; stderr truncated: ${String(stderrTruncated || bytes.length > 4096)}`
      : 'stderr empty: unknown; retained bytes: unknown; stderr truncated: unknown';
    // A source failure has no current successful stdout result to describe.
    const stdoutKnown = resultKnown && status !== 'unavailable';
    throw new Error(
      `Preset jq command failed\ncontext: ${context}; argv withheld\nexit code: ${status}\nfailure category: ${category}\nstderr capture: ${complete ? 'complete' : 'incomplete'}\nstderr: ${complete ? (bytes.length ? 'content withheld' : '(empty)') : '(unavailable)'}\n${metadata}\nstdout empty: ${stdoutKnown ? String(!stdout.trim()) : 'unknown'}; truncated: ${stdoutKnown ? String(truncated) : 'unknown'}`,
    );
  }
}
