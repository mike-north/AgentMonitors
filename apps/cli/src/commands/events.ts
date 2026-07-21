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

/**
 * `events list --format text` documents one record per line: a real daemon
 * event's `title`/`summary`/`monitorId` are untrusted, source- or
 * author-controlled text (a monitor's authored `name` (frontmatter), or a
 * source's own `title`/`summary` -- 002 section 5.4 / 003 section 2) that can
 * carry a raw CR, LF, Unicode line/paragraph separator, or a terminal escape
 * sequence. Left unescaped, a newline forges a second row and an ESC sequence
 * reaches the terminal unchanged (issue #449 review). Line-breaking characters
 * collapse to a single space (readable, keeps the row a single physical
 * line); every other C0/C1 control character (DEL included) is escaped to a
 * visible `\uXXXX` form instead of being dropped, so a hostile payload is
 * visible rather than silently absorbed. TAB (U+0009) is a C0 control too --
 * left raw it can still shift the visual column layout of the row -- so it is
 * escaped here rather than treated as a line-break character (issue #449
 * review). The regexes below are built entirely from `\uXXXX` escapes -- no
 * literal control byte lives in this source file.
 */
const LINE_BREAK_CHARS = new RegExp('[\\r\\n\\u2028\\u2029]+', 'g');
const OTHER_CONTROL_CHARS = new RegExp(
  // eslint-disable-next-line no-control-regex -- deliberately matching C0/C1 controls to escape them (see doc comment above)
  '[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F]',
  'g',
);
export function singleLineSafe(value: string): string {
  return value
    .replace(LINE_BREAK_CHARS, ' ')
    .replace(
      OTHER_CONTROL_CHARS,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
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
          // indistinguishable duplicates. Append `summary` whenever it says
          // something the title doesn't already -- i.e. differs from `title`.
          //
          // Deliberately NOT also suppressed when `summary === body`, unlike
          // `buildEventBlock`'s detail line (delivery-event-render.ts): that
          // guard exists there because the block template also renders `body`
          // on its own line below, so an equal summary/body would duplicate
          // it. This `--format text` row never renders `event.body` at all, so
          // there is no duplicate to guard against -- suppressing on
          // `summary === body` here would just drop the only per-object
          // detail a `{ title, body }`-only observation has (issue #449
          // review).
          const detail =
            event.summary && event.summary !== event.title
              ? `  ${singleLineSafe(event.summary)}`
              : '';
          // Every human-text field below is untrusted (title, monitorId) --
          // sanitized via `singleLineSafe` so a hostile payload cannot forge an
          // extra row or emit a raw terminal escape sequence (issue #449
          // review). The equality checks above compare the RAW values (dedup
          // logic must not be fooled by two distinct strings that happen to
          // collapse to the same sanitized text).
          console.log(
            `${event.id}  ${singleLineSafe(event.monitorId)}  ${event.urgency}  ${event.deliveryState ?? 'unread'}  ${singleLineSafe(event.title)}${detail}`,
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
    'Comma-separated event ids; omit to ack all unread (except a row leased by an in-flight delivery reservation)',
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
