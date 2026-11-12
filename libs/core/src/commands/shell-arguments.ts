/**
 * Literal POSIX shell arguments for commands surfaced by core diagnostics and
 * CLI suggestions. The host-neutral quoting rule lives below both consumers;
 * command routing and filesystem defaults remain each caller's responsibility.
 */
/**
 * POSIX single-quote `value`: close the quote, escape an embedded `'`, and
 * reopen it, so any text (a workspace path such as "Mike's Mac", a JSON
 * payload) stays one literal argument.
 * @public
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Quote only when the value is not already shell-safe, keeping ordinary ids readable. @public */
export function shellArg(value: string): string {
  return /^[\w./@:+-]+$/.test(value) ? value : shellSingleQuote(value);
}
