import { Command, Option } from 'commander';
import type { InboxFilter, InboxItemState } from '@agentmonitors/core';
import { createDb, InboxService } from '@agentmonitors/core';
import { resolveDbPath } from '../db-path.js';
import { reportError } from '../output.js';

const STATES = [
  'queued',
  'acked',
  'in-progress',
  'completed',
  'failed',
  'archived',
];
const URGENCIES = ['low', 'normal', 'high'];

export const inboxCommand = new Command('inbox').description(
  'Manage inbox items',
);

inboxCommand
  .command('list')
  .description('List inbox items')
  .addOption(new Option('--state <state>', 'Filter by state').choices(STATES))
  .addOption(
    new Option('--urgency <urgency>', 'Filter by urgency').choices(URGENCIES),
  )
  .option('--tags <tags>', 'Filter by tags (comma-separated)')
  .option('--monitor <id>', 'Filter by monitor ID')
  .option('--since <date>', 'Items created after this date (ISO 8601)')
  .option('--until <date>', 'Items created before this date (ISO 8601)')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(
    (options: {
      state?: string;
      urgency?: string;
      tags?: string;
      monitor?: string;
      since?: string;
      until?: string;
      format: string;
    }) => {
      let inbox: InboxService;
      try {
        inbox = new InboxService(createDb(resolveDbPath()));
      } catch (err) {
        reportError(
          err instanceof Error ? err.message : String(err),
          options.format === 'json',
        );
        return;
      }

      const filter: InboxFilter = {};
      if (options.state) {
        filter.state = options.state as InboxItemState;
      }
      if (options.urgency) {
        filter.urgency = options.urgency as 'low' | 'normal' | 'high';
      }
      if (options.tags) {
        filter.tags = options.tags.split(',').map((t) => t.trim());
      }
      if (options.monitor) {
        filter.monitorId = options.monitor;
      }
      if (options.since) {
        const d = new Date(options.since);
        if (isNaN(d.getTime())) {
          reportError(
            '--since must be a valid ISO 8601 date.',
            options.format === 'json',
          );
          return;
        }
        filter.since = d;
      }
      if (options.until) {
        const d = new Date(options.until);
        if (isNaN(d.getTime())) {
          reportError(
            '--until must be a valid ISO 8601 date.',
            options.format === 'json',
          );
          return;
        }
        filter.until = d;
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
          `[${item.state}] ${item.id}  ${item.title}  (${item.urgency})`,
        );
      }
    },
  );

function handleTransitionError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

inboxCommand
  .command('ack')
  .description('Acknowledge an inbox item')
  .argument('<id>', 'Inbox item ID')
  .action((id: string) => {
    try {
      const inbox = new InboxService(createDb(resolveDbPath()));
      inbox.ack(id);
      console.log(`Acknowledged: ${id}`);
    } catch (err) {
      handleTransitionError(err);
    }
  });

inboxCommand
  .command('start')
  .description('Mark an inbox item as in-progress')
  .argument('<id>', 'Inbox item ID')
  .action((id: string) => {
    try {
      const inbox = new InboxService(createDb(resolveDbPath()));
      inbox.start(id);
      console.log(`Started: ${id}`);
    } catch (err) {
      handleTransitionError(err);
    }
  });

inboxCommand
  .command('complete')
  .description('Mark an inbox item as completed')
  .argument('<id>', 'Inbox item ID')
  .action((id: string) => {
    try {
      const inbox = new InboxService(createDb(resolveDbPath()));
      inbox.complete(id);
      console.log(`Completed: ${id}`);
    } catch (err) {
      handleTransitionError(err);
    }
  });

inboxCommand
  .command('fail')
  .description('Mark an inbox item as failed')
  .argument('<id>', 'Inbox item ID')
  .option('--error <message>', 'Error message')
  .action((id: string, options: { error?: string }) => {
    try {
      const inbox = new InboxService(createDb(resolveDbPath()));
      inbox.fail(id, options.error);
      console.log(`Failed: ${id}`);
    } catch (err) {
      handleTransitionError(err);
    }
  });

inboxCommand
  .command('archive')
  .description('Archive a completed or failed inbox item')
  .argument('<id>', 'Inbox item ID')
  .action((id: string) => {
    try {
      const inbox = new InboxService(createDb(resolveDbPath()));
      inbox.archive(id);
      console.log(`Archived: ${id}`);
    } catch (err) {
      handleTransitionError(err);
    }
  });
