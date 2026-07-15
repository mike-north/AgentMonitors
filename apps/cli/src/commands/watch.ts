import { Command, Option } from 'commander';
import { reportError } from '../output.js';
import {
  cancelWatchClient,
  declareWatchClient,
  listWatchClient,
} from '../runtime-client.js';
import {
  isManualDaemonConnectionError,
  manualDaemonErrorMessage,
  resolveManualDaemonSocketPath,
} from '../manual-daemon.js';

/**
 * Parse the `--scope` value into a source-specific config object (005 §14.4).
 *
 * Two forms are accepted so a declaration can express every source's scope:
 *  - **JSON** — when the value is a JSON object (starts with `{`), it is parsed
 *    verbatim, so array/nested/typed scopes work (e.g.
 *    `--scope '{"globs":["src/**"],"cwd":"/x"}'`).
 *  - **`key=value,...`** — a lightweight form for the common scalar-valued case
 *    (e.g. `--scope 'cron=* * * * *,timezone=UTC'`). Values are strings; the
 *    entry separator is `,`, so a scalar value cannot itself contain a comma
 *    (use the JSON form for those).
 *
 * The runtime validates the parsed object against the source's `scopeSchema`
 * (the same `validateScope` path as `agentmonitors validate`), so this parser is
 * purely syntactic — it never judges scope validity.
 */
export function parseWatchScope(scope: string): Record<string, unknown> {
  const trimmed = scope.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('--scope JSON must be an object.');
    }
    return parsed as Record<string, unknown>;
  }
  const entries = trimmed
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const index = segment.indexOf('=');
      if (index === -1) {
        throw new Error(
          `--scope entry "${segment}" is not a key=value pair (or valid JSON).`,
        );
      }
      return [
        segment.slice(0, index).trim(),
        segment.slice(index + 1),
      ] as const;
    });
  return Object.fromEntries(entries);
}

export const watchCommand = new Command('watch').description(
  'Declare, list, or cancel an ephemeral (session-scoped) monitor',
);

watchCommand
  .command('declare <source>', { isDefault: true })
  .description(
    'Declare an ephemeral monitor on the same pipeline as a MONITOR.md monitor',
  )
  .requiredOption('--session <id>', 'Declaring AgentMon session id (required)')
  .requiredOption(
    '--scope <spec>',
    'Source scope as key=value,... or a JSON object',
  )
  .option(
    '--urgency <band>',
    'Urgency level or band, e.g. "normal" or "normal..high"',
  )
  .option(
    '--instruction <text>',
    'Handling guidance surfaced when the monitor fires',
  )
  .option('--display-name <name>', 'Human-readable name for the watch')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(
    async (
      source: string,
      options: {
        session: string;
        scope: string;
        urgency?: string;
        instruction?: string;
        displayName?: string;
        socket?: string;
        format: string;
      },
    ) => {
      let scope: Record<string, unknown>;
      try {
        scope = parseWatchScope(options.scope);
      } catch (error) {
        reportError(
          error instanceof Error ? error.message : String(error),
          options.format === 'json',
        );
        return;
      }
      try {
        const record = await declareWatchClient(
          {
            sessionId: options.session,
            source,
            scope,
            ...(options.urgency ? { urgency: options.urgency } : {}),
            ...(options.instruction
              ? { instruction: options.instruction }
              : {}),
            ...(options.displayName
              ? { displayName: options.displayName }
              : {}),
          },
          resolveManualDaemonSocketPath(options.socket),
        );
        if (options.format === 'json') {
          console.log(JSON.stringify(record, null, 2));
          return;
        }
        console.log(`Declared ephemeral monitor: ${record.id}`);
        console.log(`Source: ${record.sourceName}`);
        console.log(`Urgency: ${record.urgency}`);
      } catch (error) {
        reportError(
          manualDaemonErrorMessage(error),
          !isManualDaemonConnectionError(error) && options.format === 'json',
        );
      }
    },
  );

watchCommand
  .command('list')
  .description('List a session’s active ephemeral monitors')
  .requiredOption('--session <id>', 'AgentMon session id (required)')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(
    async (options: { session: string; socket?: string; format: string }) => {
      try {
        const records = await listWatchClient(
          options.session,
          resolveManualDaemonSocketPath(options.socket),
        );
        if (options.format === 'json') {
          console.log(JSON.stringify(records, null, 2));
          return;
        }
        if (records.length === 0) {
          console.log('No ephemeral monitors found.');
          return;
        }
        for (const record of records) {
          console.log(
            `${record.id}  ${record.sourceName}  ${record.urgency}  ${record.status}`,
          );
        }
      } catch (error) {
        reportError(
          manualDaemonErrorMessage(error),
          !isManualDaemonConnectionError(error) && options.format === 'json',
        );
      }
    },
  );

watchCommand
  .command('cancel <ephemeralId>')
  .description('Cancel (immediately reap) an ephemeral monitor')
  .requiredOption('--session <id>', 'Owning AgentMon session id (required)')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(
    async (
      ephemeralId: string,
      options: { session: string; socket?: string; format: string },
    ) => {
      try {
        const record = await cancelWatchClient(
          options.session,
          ephemeralId,
          resolveManualDaemonSocketPath(options.socket),
        );
        if (options.format === 'json') {
          console.log(JSON.stringify(record, null, 2));
          return;
        }
        console.log(`Cancelled ephemeral monitor: ${record.id}`);
      } catch (error) {
        reportError(
          manualDaemonErrorMessage(error),
          !isManualDaemonConnectionError(error) && options.format === 'json',
        );
      }
    },
  );
