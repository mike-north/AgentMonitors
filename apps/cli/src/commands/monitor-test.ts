import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { parseMonitor, SourceRegistry } from '@agentmonitors/core';
import { registerCoreSources } from '../sources.js';

export const monitorTestCommand = new Command('monitor').description(
  'Monitor utilities',
);

monitorTestCommand
  .command('test')
  .description('Dry-run a monitor observation source')
  .argument('<path>', 'Path to MONITOR.md file')
  .action(async (filePath: string) => {
    const content = readFileSync(filePath, 'utf-8');
    const result = parseMonitor(content, filePath);

    if (!result.ok) {
      console.error(`Parse error: ${result.error}`);
      process.exitCode = 1;
      return;
    }

    const registry = new SourceRegistry();
    registerCoreSources(registry);

    const source = registry.get(result.monitor.frontmatter.source);
    if (!source) {
      console.error(
        `Unknown source: "${result.monitor.frontmatter.source}". Available: ${registry.names().join(', ')}`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `Testing monitor "${result.monitor.frontmatter.name}" (source: ${source.name})...`,
    );

    try {
      const observations = await source.observe(
        result.monitor.frontmatter.scope,
      );

      if (observations.length === 0) {
        console.log('No observations produced.');
      } else {
        console.log(`${String(observations.length)} observation(s):\n`);
        for (const obs of observations) {
          console.log(`  Title: ${obs.title}`);
          console.log(`  Snapshot: ${JSON.stringify(obs.snapshot, null, 2)}`);
          console.log('');
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Observation failed: ${message}`);
      process.exitCode = 1;
    }
  });
