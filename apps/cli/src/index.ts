import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { validateCommand } from './commands/validate.js';
import { scanCommand } from './commands/scan.js';
import { inboxCommand } from './commands/inbox.js';
import { monitorTestCommand } from './commands/monitor-test.js';
import { sourceCommand } from './commands/source.js';
import { schemaCommand } from './commands/schema.js';

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

program.parse();
