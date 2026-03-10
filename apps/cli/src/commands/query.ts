import { Command } from 'commander';
import type { InboxFilter, InboxItemState } from '@agentmonitors/core';
import { createDb, InboxService } from '@agentmonitors/core';
import { resolveDbPath } from '../db-path.js';

export const queryCommand = new Command('query')
  .description('Query inbox items with filters')
  .option('--state <state>', 'Filter by state')
  .option('--urgency <urgency>', 'Filter by urgency (high | normal)')
  .option(
    '--event-kind <kind>',
    'Filter by event kind (mutation | notification | alert)',
  )
  .option('--tags <tags>', 'Filter by tags (comma-separated)')
  .option('--monitor <id>', 'Filter by monitor ID')
  .option('--since <date>', 'Items created after this date (ISO 8601)')
  .option('--until <date>', 'Items created before this date (ISO 8601)')
  .option('--format <format>', 'Output format (text | json)', 'text')
  .action(
    (options: {
      state?: string;
      urgency?: string;
      eventKind?: string;
      tags?: string;
      monitor?: string;
      since?: string;
      until?: string;
      format: string;
    }) => {
      const db = createDb(resolveDbPath());
      const inbox = new InboxService(db);

      const filter: InboxFilter = {};
      if (options.state) {
        filter.state = options.state as InboxItemState;
      }
      if (options.urgency) {
        filter.urgency = options.urgency as 'high' | 'normal';
      }
      if (options.eventKind) {
        filter.eventKind = options.eventKind as
          | 'mutation'
          | 'notification'
          | 'alert';
      }
      if (options.tags) {
        filter.tags = options.tags.split(',').map((t) => t.trim());
      }
      if (options.monitor) {
        filter.monitorId = options.monitor;
      }
      if (options.since) {
        filter.since = new Date(options.since);
      }
      if (options.until) {
        filter.until = new Date(options.until);
      }

      const items = inbox.list(filter);

      if (options.format === 'json') {
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      if (items.length === 0) {
        console.log('No items match the query.');
        return;
      }

      console.log(`${String(items.length)} item(s) found:\n`);
      for (const item of items) {
        console.log(
          `[${item.state}] ${item.id}  ${item.title}  (${item.urgency}, ${item.eventKind})`,
        );
      }
    },
  );
