import { Command, Option } from 'commander';
import { reportError } from '../output.js';
import { renderToon, resolveFormat } from '../toon-format.js';
import {
  acknowledgeEventsClient,
  listEventsClient,
} from '../runtime-client.js';
import {
  isManualDaemonConnectionError,
  manualDaemonErrorMessage,
  resolveManualDaemonSocketPath,
} from '../manual-daemon.js';
import { appendErrorHints } from '../command-hints.js';

/**
 * Both `events list` and `events ack` require `--session`, an id the user has
 * no obvious way to discover from the bare `error: required option ...` line
 * (issue #420 P2). Point them at `session list`, and note the same in
 * `--help`.
 */
const SESSION_DISCOVERY_HINT =
  'Run `agentmonitors session list` to find a session id.';
const REQUIRED_SESSION_ERROR_HINT = {
  pattern: /required option '--session/,
  hint: SESSION_DISCOVERY_HINT,
} as const;

function parseScope(scope?: string): Record<string, string> | undefined {
  if (!scope) return undefined;
  const entries = scope
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const [key, value] = segment.split('=');
      return [key?.trim(), value?.trim()] as const;
    })
    .filter(([key, value]) => key && value) as [string, string][];
  return Object.fromEntries(entries);
}

function collectTag(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export const eventsCommand = new Command('events').description(
  'Query or acknowledge runtime events',
);

const eventsListCommand = eventsCommand
  .command('list')
  // The summary itself names the required option (issue #389 P3): `events
  // --help` renders only this line per subcommand, so without it the
  // requirement is discoverable only by running the command and reading
  // commander's `error: required option '--session <id>' not specified`.
  .description('List events for a session (requires --session <id>)')
  .requiredOption('--session <id>', 'AgentMon session id (required)')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .option('--monitor <id>', 'Filter by monitor id')
  .addOption(
    new Option('--urgency <urgency>', 'Filter by urgency').choices([
      'low',
      'normal',
      'high',
    ]),
  )
  .option('--tag <tag>', 'Filter by tag (repeatable)', collectTag, [])
  .option('--scope <pairs>', 'Scope filters like key=value,key2=value2')
  .option('--unread', 'Only unread events')
  .option('--since-baseline', 'Only include events since the session baseline')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['toon', 'json', 'text'])

      .default(undefined, 'auto (toon for agents, text for humans)'),
  )
  .action(
    async (options: {
      session: string;
      socket?: string;
      monitor?: string;
      urgency?: 'low' | 'normal' | 'high';
      tag: string[];
      scope?: string;
      unread?: boolean;
      sinceBaseline?: boolean;
      format: string | undefined;
    }) => {
      const format = resolveFormat(options.format);
      try {
        const scope = parseScope(options.scope);
        const events = await listEventsClient(
          {
            sessionId: options.session,
            ...(options.monitor ? { monitorId: options.monitor } : {}),
            ...(options.urgency ? { urgency: options.urgency } : {}),
            ...(options.tag.length > 0 ? { tags: options.tag } : {}),
            ...(scope ? { scope } : {}),
            ...(options.unread ? { unreadOnly: true } : {}),
            ...(options.sinceBaseline ? { sinceBaseline: true } : {}),
          },
          resolveManualDaemonSocketPath(options.socket),
        );
        if (format === 'json') {
          console.log(JSON.stringify(events, null, 2));
          return;
        }
        if (format === 'toon') {
          console.log(renderToon(events));
          return;
        }
        // text format
        if (events.length === 0) {
          console.log('No events found.');
          return;
        }
        for (const event of events) {
          // deliveryState (issue #338, 002 §7) is always present here: this
          // query is always session-scoped (`--session` is required). It's
          // printed as its own column so `--unread` output doesn't read as
          // "never seen" -- --unread matches acknowledgedAt IS NULL, which
          // INCLUDES claimed-but-unacknowledged events.
          //
          // `event.title` is the monitor's authored name (002 §5.4, issue
          // #449) -- it says what the monitor is FOR, not which object moved.
          // A multi-object source (e.g. file-fingerprint watching a glob)
          // emits one row per object, all sharing that same title, so without
          // the per-object `summary` those rows would render as
          // indistinguishable duplicates. Mirror `buildEventBlock`'s detail
          // line (delivery-event-render.ts): append `summary` only when it
          // says something the title doesn't already -- i.e. differs from
          // both `title` and `body` (the latter guards against a source that
          // supplies only `title` + `body`, where materialization derives
          // the absent `summary` from `body`, 002 §5.1).
          const detail =
            event.summary &&
            event.summary !== event.title &&
            event.summary !== event.body
              ? `  ${event.summary}`
              : '';
          console.log(
            `${event.id}  ${event.monitorId}  ${event.urgency}  ${event.deliveryState ?? 'unread'}  ${event.title}${detail}`,
          );
        }
      } catch (error) {
        reportError(
          manualDaemonErrorMessage(error),
          !isManualDaemonConnectionError(error) && format === 'json',
        );
      }
    },
  )
  .addHelpText('after', `\n${SESSION_DISCOVERY_HINT}`);
appendErrorHints(eventsListCommand, [REQUIRED_SESSION_ERROR_HINT]);

const eventsAckCommand = eventsCommand
  .command('ack')
  // Same requirement, same reason as `events list` above (issue #389 P3).
  .description(
    'Acknowledge one or more events for a session (requires --session <id>)',
  )
  .requiredOption('--session <id>', 'AgentMon session id (required)')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .option(
    '--event-ids <ids>',
    'Comma-separated event ids; omit to ack all unread',
  )
  .action(
    async (options: {
      session: string;
      socket?: string;
      eventIds?: string;
    }) => {
      const ids = options.eventIds
        ?.split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      try {
        await acknowledgeEventsClient(
          options.session,
          ids,
          resolveManualDaemonSocketPath(options.socket),
        );
        console.log('Acknowledged events.');
      } catch (error) {
        reportError(manualDaemonErrorMessage(error), false);
      }
    },
  )
  .addHelpText('after', `\n${SESSION_DISCOVERY_HINT}`);
appendErrorHints(eventsAckCommand, [REQUIRED_SESSION_ERROR_HINT]);
