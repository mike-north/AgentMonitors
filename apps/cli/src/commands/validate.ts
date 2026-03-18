import { Command, Option } from 'commander';
import { scanMonitors, SourceRegistry } from '@agentmonitors/core';
import type { JsonSchema } from '@agentmonitors/core';
import { registerCoreSources } from '../sources.js';
import { requireDirectory } from '../validation.js';

/**
 * Validate a scope object against a source's JSON Schema fragment.
 * Checks that all required fields are present.
 */
function validateScope(
  scope: Record<string, unknown>,
  schema: JsonSchema,
): string[] {
  const errors: string[] = [];

  const required = schema['required'];
  if (Array.isArray(required)) {
    for (const field of required) {
      if (typeof field === 'string' && !(field in scope)) {
        errors.push(`Missing required scope field: "${field}"`);
      }
    }
  }

  return errors;
}

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

    const allErrors = [
      ...result.errors.map((e) => ({
        filePath: e.filePath,
        error: e.error,
      })),
      ...scopeErrors.map((e) => ({
        filePath: e.id,
        error: e.errors.join('; '),
      })),
    ];

    if (options.format === 'json') {
      const output = {
        valid: validMonitors.length,
        invalid: allErrors.length,
        monitors: validMonitors.map((m) => ({
          id: m.monitor.id,
          name: m.monitor.frontmatter.name,
          source: m.monitor.frontmatter.source,
        })),
        errors: allErrors,
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      if (validMonitors.length > 0) {
        console.log(`Valid monitors: ${String(validMonitors.length)}`);
        for (const m of validMonitors) {
          console.log(`  ${m.monitor.id}: ${m.monitor.frontmatter.name}`);
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
