import type { Command } from 'commander';

/** A single contextual remediation hint keyed on the text of a Commander error. */
export interface ErrorHint {
  /**
   * Tested against each chunk Commander writes to stderr. Keep it specific to
   * the exact error (e.g. the option flag) so the hint only appends to the line
   * it is meant for — never to unrelated diagnostics.
   */
  readonly pattern: RegExp;
  /** The remediation line to append. A trailing newline is added if missing. */
  readonly hint: string;
}

/**
 * Append contextual remediation hints to a Commander command's parse errors
 * (missing required option, unknown option, …) WITHOUT altering the default
 * error line, the exit code, or `--help` output.
 *
 * Commander routes every error line through `configureOutput().writeErr`, so we
 * tee the original chunk through unchanged and, when it matches a hint's
 * `pattern`, write one extra stderr line pointing the user at the fix. This is
 * strictly additive: the built-in `error:` line and non-zero exit are
 * untouched, and stdout is never written (help text goes through `writeOut`, a
 * different sink). Used for the manual/no-docs CLI-path papercuts in issue #420
 * — e.g. `events list` missing `--session`, or `monitor history` given `--dir`.
 *
 * @returns the same command, for chaining.
 */
export function appendErrorHints(
  command: Command,
  hints: readonly ErrorHint[],
): Command {
  command.configureOutput({
    writeErr: (str) => {
      process.stderr.write(str);
      for (const { pattern, hint } of hints) {
        if (pattern.test(str)) {
          process.stderr.write(hint.endsWith('\n') ? hint : `${hint}\n`);
        }
      }
    },
  });
  return command;
}
