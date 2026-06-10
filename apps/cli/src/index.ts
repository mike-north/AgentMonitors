import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { channelCommand } from './commands/channel.js';

/**
 * Read the CLI's version from its own package.json. Both the TS source
 * (`src/index.ts`) and the bundled artifact (`dist/index.cjs`) sit one level
 * below the package root, so a single `..` resolves the manifest in either
 * layout. (tsup's `shims: true` provides `import.meta.url` in the CJS bundle.)
 * Never hardcode a version literal here — it silently drifts from the real
 * release and makes `--version` useless for diagnosing user installs.
 */
function getVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(dir, '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const program = new Command();

program
  .name('agentmonitors')
  .description('Durable observation and inbox delivery for AI agents')
  .version(getVersion());

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
program.addCommand(channelCommand);

program.parse();
