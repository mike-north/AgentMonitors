/**
 * Literal POSIX shell arguments and monitor command lines shared by core
 * diagnostics and CLI suggestions. Quoting and the option/identity boundary
 * live below both consumers; routing and filesystem defaults remain with callers.
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

/**
 * Build a monitor suggestion from raw command words, option/value arguments,
 * and monitor/retry IDs. Every option precedes `--`, and every ID follows it:
 * quoting alone cannot keep a legal leading-hyphen ID positional. Callers own
 * the command route and scope; no input may be pre-quoted for the shell.
 *
 * Internal coordination between runtime diagnostics and the bundled CLI;
 * omitted from the published public declaration rollup.
 * @internal
 */
export function _monitorCommandLine(
  command: readonly string[],
  flags: readonly string[],
  ids: readonly string[],
): string {
  return ['agentmonitors', 'monitor', ...command, ...flags, '--', ...ids]
    .map(shellArg)
    .join(' ');
}
