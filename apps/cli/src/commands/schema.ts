import { Command } from 'commander';
import { generateMonitorSchema, SourceRegistry } from '@agentmonitors/core';
import { registerCoreSources } from '../sources.js';

export const schemaCommand = new Command('schema').description(
  'JSON Schema management',
);

schemaCommand
  .command('generate')
  .description(
    'Generate a JSON Schema from installed observation source plugins',
  )
  .option('-o, --output <file>', 'Write schema to file instead of stdout')
  .action(async (options: { output?: string }) => {
    const registry = new SourceRegistry();
    registerCoreSources(registry);

    const schema = generateMonitorSchema(registry.list());

    const json = JSON.stringify(schema, null, 2);

    if (options.output) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(options.output, json, 'utf-8');
      console.log(`Schema written to ${options.output}`);
    } else {
      console.log(json);
    }
  });
