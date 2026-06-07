import { Command, Option } from 'commander';
import { reportError } from '../output.js';
import {
  acknowledgeEventsClient,
  listEventsClient,
} from '../runtime-client.js';

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

eventsCommand
  .command('list')
  .description('List events for a session')
  .requiredOption('--session <id>', 'AgentMon session id')
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
      .choices(['text', 'json'])
      .default('text'),
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
      format: string;
    }) => {
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
          options.socket,
        );
        if (options.format === 'json') {
          console.log(JSON.stringify(events, null, 2));
          return;
        }
        if (events.length === 0) {
          console.log('No events found.');
          return;
        }
        for (const event of events) {
          console.log(
            `${event.id}  ${event.monitorId}  ${event.urgency}  ${event.title}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reportError(message, options.format === 'json');
      }
    },
  );

eventsCommand
  .command('ack')
  .description('Acknowledge one or more events for a session')
  .requiredOption('--session <id>', 'AgentMon session id')
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
      await acknowledgeEventsClient(options.session, ids, options.socket);
      console.log('Acknowledged events.');
    },
  );
