/**
 * Shared knowledge of the `init --type command-poll` scaffold default, used by
 * both the scaffolder (`init.ts`) and the linter (`validate.ts`).
 *
 * `command-poll`'s `command:` is the entire intent of the monitor — unlike
 * `file-fingerprint`'s `globs:` there is no universally-sensible default. The
 * template ships an illustrative upstream-tip probe so the scaffold validates
 * and runs, but a scaffold left at that untouched default silently watches the
 * wrong thing for any other intent (issue #388). `validate` treats a monitor
 * whose `command:` still equals this default as a soft warning so a wrong-intent
 * ship is caught instead of passing as if configured. Kept in its own module so
 * `validate.ts` can import it without a cycle through `init.ts` (which imports
 * `validateCommand`).
 */

/**
 * The exact argv the command-poll template scaffolds when `--command` is
 * omitted. A drift-guard test asserts the template's `command:` block still
 * equals this array so the two cannot silently diverge.
 */
export const COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND: readonly string[] = [
  'git',
  'ls-remote',
  'origin',
  'refs/heads/main',
];

/**
 * The soft warning `validate` emits for a command-poll monitor whose
 * `watch.command` is still the untouched scaffold default. It is advisory only:
 * it does not mark the monitor invalid or change the exit code. The final
 * sentence documents the escape hatch for the (legitimate) case where polling
 * the upstream branch tip is the real intent.
 */
export const COMMAND_POLL_SCAFFOLD_WARNING = `watch.command is still the untouched 'init --type command-poll' scaffold default (${COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND.join(' ')}) — set it to the command this monitor should poll, e.g. re-scaffold with 'init <name> --type command-poll --command git --command status --command --porcelain'. If polling the upstream branch tip is what you intend, this warning is safe to ignore.`;

/**
 * True when `command` is exactly the untouched command-poll scaffold default
 * ({@link COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND}). Accepts `unknown` because it
 * is called on a parsed `watch.command` field whose static type is `unknown`
 * (the source config is a schema `catchall`); any non-matching value (wrong
 * type, wrong length, edited tokens) returns `false`.
 */
export function isUntouchedCommandPollDefault(command: unknown): boolean {
  return (
    Array.isArray(command) &&
    command.length === COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND.length &&
    command.every(
      (token, index) => token === COMMAND_POLL_SCAFFOLD_DEFAULT_COMMAND[index],
    )
  );
}
