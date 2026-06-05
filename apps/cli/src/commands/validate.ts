import { Command, Option } from 'commander';
import { scanMonitors, SourceRegistry, validateScope } from '@mike-north/core';
import { registerCoreSources } from '../sources.js';
import { requireDirectory } from '../validation.js';

export const validateCommand = new Command('validate')
  .description('Validate MONITOR.md files in a directory')
  .argument('[path]', 'Path to monitors directory', '.claude/monitors')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(async (monitorPath: string, options: { format: string }) => {
    if (!requireDirectory(monitorPath, options.format === 'json')) return;

    const result = await scanMonitors(monitorPath);

    const registry = new SourceRegistry();
    registerCoreSources(registry);

    // Validate source names and scope against source-specific schemas
    const scopeErrors: { id: string; errors: string[] }[] = [];
    const validMonitors = result.monitors.filter((m) => {
      const sourceName = m.monitor.frontmatter.source;
      const source = registry.get(sourceName);
      if (!source) {
        scopeErrors.push({
          id: m.monitor.id,
          errors: [
            `Unknown source "${sourceName}". Available sources: ${registry.names().join(', ')}`,
          ],
        });
        return false;
      }

      const errors = validateScope(
        m.monitor.frontmatter.scope,
        source.scopeSchema,
      );
      if (errors.length > 0) {
        scopeErrors.push({ id: m.monitor.id, errors });
        return false;
      }
      return true;
    });

    // Duplicate folder-derived ids are a tree-level correctness error (SP2),
    // independent of whether each file parses.
    const duplicateErrors = result.duplicateIds.map((dup) => ({
      filePath: dup.filePaths.join(', '),
      error: `Duplicate monitor id "${dup.id}" — ids are derived from folder names and must be unique within a tree`,
    }));

    const allErrors = [
      ...result.errors.map((e) => ({
        filePath: e.filePath,
        error: e.error,
      })),
      ...scopeErrors.map((e) => ({
        filePath: e.id,
        error: e.errors.join('; '),
      })),
      ...duplicateErrors,
    ];

    if (options.format === 'json') {
      const output = {
        valid: validMonitors.length,
        invalid: allErrors.length,
        monitors: validMonitors.map((m) => ({
          id: m.monitor.id,
          name: m.monitor.frontmatter.name ?? m.monitor.id,
          source: m.monitor.frontmatter.source,
        })),
        duplicateIds: result.duplicateIds,
        errors: allErrors,
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      if (validMonitors.length > 0) {
        console.log(`Valid monitors: ${String(validMonitors.length)}`);
        for (const m of validMonitors) {
          console.log(
            `  ${m.monitor.id}: ${m.monitor.frontmatter.name ?? m.monitor.id}`,
          );
        }
      }

      if (allErrors.length > 0) {
        console.log(`\nInvalid monitors: ${String(allErrors.length)}`);
        for (const e of allErrors) {
          console.log(`  ${e.filePath}: ${e.error}`);
        }
      }

      if (validMonitors.length === 0 && allErrors.length === 0) {
        console.log('No monitors found.');
      }
    }

    if (allErrors.length > 0) {
      process.exitCode = 1;
    }
  });
