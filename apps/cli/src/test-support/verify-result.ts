/** Diagnose verification subprocess failures while their owned daemon still exists. */

/** Raw subprocess evidence remains meaningful even when stdout is not a JSON report. @internal */
export interface VerifyCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Assert success without diagnostic IPC; enrich failures without masking their raw output. @internal */
export async function assertVerifySucceeded(
  result: VerifyCommandResult,
  readHistory: () => Promise<unknown>,
): Promise<void> {
  const context = `${result.stdout}\n${result.stderr}`;
  // Parse only to recognize success. Malformed output is itself failure evidence,
  // and must survive alongside stderr rather than escape as a bare SyntaxError.
  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = undefined;
  }
  if (
    result.exitCode === 0 &&
    typeof report === 'object' &&
    report !== null &&
    'ok' in report &&
    report.ok === true
  ) {
    return;
  }
  let evidence = `verify exited ${String(result.exitCode)}\n${context}`;
  try {
    evidence += `\nHistory: ${JSON.stringify(await readHistory())}`;
  } catch (error) {
    evidence += `\nHistory unavailable: ${String(error)}`;
  }
  throw new Error(evidence);
}
