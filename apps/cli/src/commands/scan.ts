import { Command } from 'commander';
import { scanMonitors } from '@agentmonitors/core';

export const scanCommand = new Command('scan')
  .description('Find and summarize all MONITOR.md files')
  .argument('[dir]', 'Directory to scan', '.claude/monitors')
  .action(async (dir: string) => {
    const result = await scanMonitors(dir);

    if (result.monitors.length === 0 && result.errors.length === 0) {
      console.log('No monitors found.');
      return;
    }

    console.log('Monitors found:\n');
    console.log(
      ['ID'.padEnd(30), 'Name'.padEnd(40), 'Source'.padEnd(20), 'Urgency'].join(
        '  ',
      ),
    );
    console.log('-'.repeat(100));

    for (const m of result.monitors) {
      const { id, frontmatter } = m.monitor;
      console.log(
        [
          id.padEnd(30),
          frontmatter.name.padEnd(40),
          frontmatter.source.padEnd(20),
          frontmatter.urgency,
        ].join('  '),
      );
    }

    if (result.errors.length > 0) {
      console.log(`\n${String(result.errors.length)} file(s) failed to parse.`);
    }
  });
