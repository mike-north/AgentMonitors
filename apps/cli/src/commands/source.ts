import { Command, Option } from 'commander';
import { SourceRegistry } from '@agentmonitors/core';
import { registerCoreSources } from '../sources.js';
import { renderToon, resolveFormat } from '../toon-format.js';

function fieldDescriptions(
  properties: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(properties).flatMap(([name, schema]) => {
      const description =
        typeof schema === 'object' &&
        schema !== null &&
        'description' in schema &&
        typeof schema.description === 'string'
          ? schema.description
          : undefined;
      return description === undefined ? [] : [[name, description]];
    }),
  );
}

function toonFieldDescriptions(
  descriptions: Record<string, string>,
): { field: string; description: string }[] {
  // TOON's nested object-map form can misread bracketed examples inside quoted
  // scalar values. An explicit list preserves the exact description text.
  return Object.entries(descriptions).map(([field, description]) => ({
    field,
    description,
  }));
}

export const sourceCommand = new Command('source').description(
  'Manage observation source plugins',
);

sourceCommand
  .command('list')
  .description('List installed observation sources')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['toon', 'json', 'text'])

      .default(undefined, 'auto (toon for agents, text for humans)'),
  )
  .action((options: { format: string | undefined }) => {
    const format = resolveFormat(options.format);
    const registry = new SourceRegistry();
    registerCoreSources(registry);

    const sources: ReturnType<SourceRegistry['list']> = registry.list();

    if (format === 'json' || format === 'toon') {
      const output = sources.map((source) => {
        const requiredFields =
          (source.scopeSchema['required'] as string[] | undefined) ?? [];
        const properties =
          (source.scopeSchema['properties'] as
            | Record<string, unknown>
            | undefined) ?? {};
        const configFields = Object.keys(properties);
        const descriptions = fieldDescriptions(properties);
        return {
          name: source.name,
          configFields,
          scopeFields: configFields,
          fieldDescriptions:
            format === 'toon'
              ? toonFieldDescriptions(descriptions)
              : descriptions,
          required: requiredFields,
        };
      });
      if (format === 'json') {
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
      const descriptions = fieldDescriptions(properties);
      for (const [field, description] of Object.entries(descriptions)) {
        console.log(`    - ${field}: ${description}`);
      }
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
