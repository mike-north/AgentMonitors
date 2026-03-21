import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { validateCommand } from './commands/validate.js';
import { scanCommand } from './commands/scan.js';
import { inboxCommand } from './commands/inbox.js';
import { monitorTestCommand } from './commands/monitor-test.js';
import { sourceCommand } from './commands/source.js';
import { schemaCommand } from './commands/schema.js';
import { daemonCommand } from './commands/daemon.js';
import { sessionCommand } from './commands/session.js';
import { eventsCommand } from './commands/events.js';
import { hookCommand } from './commands/hook.js';

const program = new Command();

program
  .name('agentmonitors')
  .description('Durable observation and inbox delivery for AI agents')
  .version('0.0.0');

program.addCommand(initCommand);
program.addCommand(validateCommand);
program.addCommand(scanCommand);
program.addCommand(inboxCommand);
program.addCommand(monitorTestCommand);
program.addCommand(sourceCommand);
program.addCommand(schemaCommand);
program.addCommand(daemonCommand);
program.addCommand(sessionCommand);
program.addCommand(eventsCommand);
program.addCommand(hookCommand);

program.parse();
