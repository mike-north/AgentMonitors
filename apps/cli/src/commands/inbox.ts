import { Command } from 'commander';
import type { InboxFilter, InboxItemState } from '@agentmonitors/core';
import { createDb, InboxService } from '@agentmonitors/core';
import { resolveDbPath } from '../db-path.js';

export const inboxCommand = new Command('inbox').description(
  'Manage inbox items',
);

inboxCommand
  .command('list')
  .description('List inbox items')
  .option('--state <state>', 'Filter by state')
  .option('--urgency <urgency>', 'Filter by urgency (high | normal)')
  .option(
    '--event-kind <kind>',
    'Filter by event kind (mutation | notification | alert)',
  )
  .option('--tags <tags>', 'Filter by tags (comma-separated)')
  .option('--monitor <id>', 'Filter by monitor ID')
  .option('--format <format>', 'Output format (text | json)', 'text')
  .action(
    (options: {
      state?: string;
      urgency?: string;
      eventKind?: string;
      tags?: string;
      monitor?: string;
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

      const items = inbox.list(filter);

      if (options.format === 'json') {
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      if (items.length === 0) {
        console.log('No inbox items found.');
        return;
      }

      for (const item of items) {
        console.log(
          `[${item.state}] ${item.id}  ${item.title}  (${item.urgency}, ${item.eventKind})`,
        );
      }
    },
  );

inboxCommand
  .command('ack')
  .description('Acknowledge an inbox item')
  .argument('<id>', 'Inbox item ID')
  .action((id: string) => {
    const db = createDb(resolveDbPath());
    const inbox = new InboxService(db);
    inbox.ack(id);
    console.log(`Acknowledged: ${id}`);
  });

inboxCommand
  .command('complete')
  .description('Mark an inbox item as completed')
  .argument('<id>', 'Inbox item ID')
  .action((id: string) => {
    const db = createDb(resolveDbPath());
    const inbox = new InboxService(db);
    inbox.complete(id);
    console.log(`Completed: ${id}`);
  });

inboxCommand
  .command('fail')
  .description('Mark an inbox item as failed')
  .argument('<id>', 'Inbox item ID')
  .option('--error <message>', 'Error message')
  .action((id: string, options: { error?: string }) => {
    const db = createDb(resolveDbPath());
    const inbox = new InboxService(db);
    inbox.fail(id, options.error);
    console.log(`Failed: ${id}`);
  });

inboxCommand
  .command('archive')
  .description('Archive a completed or failed inbox item')
  .argument('<id>', 'Inbox item ID')
  .action((id: string) => {
    const db = createDb(resolveDbPath());
    const inbox = new InboxService(db);
    inbox.archive(id);
    console.log(`Archived: ${id}`);
  });
