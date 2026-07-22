import { Command } from 'commander';
import { getCliVersion } from './cli-version.js';
import { initCommand } from './commands/init.js';
import { validateCommand } from './commands/validate.js';
import { scanCommand } from './commands/scan.js';
import { inboxCommand } from './commands/inbox.js';
import { monitorTestCommand } from './commands/monitor-test.js';
import { sourceCommand } from './commands/source.js';
import { schemaCommand } from './commands/schema.js';
import { daemonCommand } from './commands/daemon.js';
import { doctorCommand } from './commands/doctor.js';
import { verifyCommand } from './commands/verify.js';
import { sessionCommand } from './commands/session.js';
import { eventsCommand } from './commands/events.js';
import { hookCommand } from './commands/hook.js';
import { channelCommand } from './commands/channel.js';
import { watchCommand } from './commands/watch.js';

const program = new Command();

program
  .name('agentmonitors')
  .description('Durable observation and inbox delivery for AI agents')
  .version(getCliVersion());

program.addCommand(initCommand);
program.addCommand(validateCommand);
program.addCommand(scanCommand);
program.addCommand(inboxCommand);
program.addCommand(monitorTestCommand);
program.addCommand(sourceCommand);
program.addCommand(schemaCommand);
program.addCommand(daemonCommand);
program.addCommand(doctorCommand);
program.addCommand(verifyCommand);
program.addCommand(sessionCommand);
program.addCommand(eventsCommand);
program.addCommand(hookCommand);
program.addCommand(channelCommand);
program.addCommand(watchCommand);

// `parseAsync` (not `parse`): several command actions are `async`, and Commander
// does not await an action passed to the synchronous `parse()` — an action that
// rejects (e.g. `daemon run`'s loop) would surface as an unhandled promise
// rejection with a noisy stack instead of a clean error + non-zero exit. CJS
// bundles have no top-level `await`, so we handle the returned promise here.
program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
