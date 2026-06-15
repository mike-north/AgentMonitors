import { Command, Option } from 'commander';
import { SourceRegistry } from '@agentmonitors/core';
import { registerCoreSources } from '../sources.js';
import { renderToon } from '../toon-format.js';

export const sourceCommand = new Command('source').description(
  'Manage observation source plugins',
);

sourceCommand
  .command('list')
  .description('List installed observation sources')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['toon', 'json', 'text'])
      .default('toon'),
  )
  .action((options: { format: string }) => {
    const registry = new SourceRegistry();
    registerCoreSources(registry);

    const sources: ReturnType<SourceRegistry['list']> = registry.list();

    if (options.format === 'json' || options.format === 'toon') {
      const output = sources.map((source) => {
        const requiredFields =
          (source.scopeSchema['required'] as string[] | undefined) ?? [];
        const properties =
          (source.scopeSchema['properties'] as
            | Record<string, unknown>
            | undefined) ?? {};
        const configFields = Object.keys(properties);
        return {
          name: source.name,
          configFields,
          scopeFields: configFields,
          required: requiredFields,
        };
      });
      if (options.format === 'json') {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(renderToon(output));
      }
      return;
    }

    if (sources.length === 0) {
      console.log('No sources installed.');
      return;
    }

    console.log('Installed sources:\n');
    for (const source of sources) {
      const requiredFields =
        (source.scopeSchema['required'] as string[] | undefined) ?? [];
      const properties =
        (source.scopeSchema['properties'] as
          | Record<string, unknown>
          | undefined) ?? {};
      console.log(`  ${source.name}`);
      console.log(`    Config fields: ${Object.keys(properties).join(', ')}`);
      console.log(`    Required: ${requiredFields.join(', ') || '(none)'}`);
      console.log('');
    }
  });

sourceCommand
  .command('search')
  .description(
    '[not yet implemented] Search npm for observation source plugins',
  )
  .argument('[query]', 'Search query')
  .action((query?: string) => {
    console.error(
      `Plugin search is not yet implemented.${query ? ` (query: "${query}")` : ''}`,
    );
    console.error(
      'Install plugins manually: pnpm add --prefix ~/.config/agentmonitors <package-name>',
    );
    process.exitCode = 1;
  });

sourceCommand
  .command('install')
  .description('[not yet implemented] Install an observation source plugin')
  .argument('<name>', 'Package name to install')
  .action((name: string) => {
    console.error(`Plugin installation is not yet implemented: ${name}`);
    console.error(
      `Install manually: pnpm add --prefix ~/.config/agentmonitors ${name}`,
    );
    process.exitCode = 1;
  });

sourceCommand
  .command('update')
  .description('[not yet implemented] Update observation source plugins')
  .argument('[name]', 'Package name to update (or all)')
  .action((name?: string) => {
    console.error(
      `Plugin update is not yet implemented.${name ? ` (package: ${name})` : ''}`,
    );
    process.exitCode = 1;
  });

sourceCommand
  .command('remove')
  .description('[not yet implemented] Remove an observation source plugin')
  .argument('<name>', 'Package name to remove')
  .action((name: string) => {
    console.error(`Plugin removal is not yet implemented: ${name}`);
    process.exitCode = 1;
  });
