/**
 * Report an error to stdout (JSON) or stderr (text) and set exit code 1.
 */
export function reportError(message: string, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exitCode = 1;
}
