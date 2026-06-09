import { Command, Option } from 'commander';
import { scanMonitors } from '@mike-north/core';
import { requireDirectory } from '../validation.js';

export const scanCommand = new Command('scan')
  .description('Find and summarize all MONITOR.md files')
  .argument('[dir]', 'Directory to scan', '.claude/monitors')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(async (dir: string, options: { format: string }) => {
    if (!requireDirectory(dir, options.format === 'json')) return;

    const result = await scanMonitors(dir);

    if (options.format === 'json') {
      const output = {
        monitors: result.monitors.map((m) => ({
          id: m.monitor.id,
          name: m.monitor.displayName,
          source: m.monitor.frontmatter.watch.type,
          urgency: m.monitor.frontmatter.urgency,
          tags: m.monitor.frontmatter.tags ?? [],
          notify: m.monitor.frontmatter.notify ?? null,
        })),
        errors: result.errors.map((e) => ({
          filePath: e.filePath,
          error: e.error,
        })),
        duplicateIds: result.duplicateIds,
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }

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
          m.monitor.displayName.padEnd(40),
          frontmatter.watch.type.padEnd(20),
          frontmatter.urgency,
        ].join('  '),
      );
    }

    if (result.errors.length > 0) {
      console.log(`\n${String(result.errors.length)} file(s) failed to parse.`);
    }

    if (result.duplicateIds.length > 0) {
      console.log(
        `\nDuplicate monitor id(s) — ids must be unique within a tree:`,
      );
      for (const dup of result.duplicateIds) {
        console.log(`  ${dup.id}: ${dup.filePaths.join(', ')}`);
      }
    }
  });
