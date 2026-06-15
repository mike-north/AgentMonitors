import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  scanMonitors,
  SourceRegistry,
  validateScope,
} from '@agentmonitors/core';
import { registerCoreSources } from '../sources.js';
import { requireDirectory } from '../validation.js';

/**
 * Derive the monitor ID from a file path, mirroring the logic in parseMonitor.
 * Used to display the monitor ID rather than the full file path in error output
 * (ID = parent dir name for MONITOR.md files, stem for flat .md files).
 */
function monitorIdFromPath(filePath: string): string {
  const base = path.basename(filePath);
  return base === 'MONITOR.md'
    ? path.basename(path.dirname(filePath))
    : path.parse(filePath).name;
}

/**
 * Returns the actionable BP3 error when a `change-detection.collection` block is
 * present without `strategy: json-diff` (003 §12), or `undefined` otherwise. Mirrors
 * the schema's `if/then` rule with a clearer, author-facing message.
 */
function changeDetectionCollectionError(
  watchConfig: Record<string, unknown>,
): string | undefined {
  const cd = watchConfig['change-detection'];
  if (cd === null || typeof cd !== 'object' || Array.isArray(cd))
    return undefined;
  const cdObj = cd as Record<string, unknown>;
  if (cdObj['collection'] === undefined) return undefined;
  const strategy = cdObj['strategy'];
  if (strategy === 'json-diff') return undefined;
  return 'change-detection.collection requires strategy: json-diff';
}

// Old public docs used top-level `source:` + `scope:` before the current
// `watch: { type, ... }` authoring shape. Detect only that exact parse failure
// pattern so unrelated schema errors are not polluted with migration advice.
function oldSourceScopeShapeHint(filePath: string): string | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  // Strip an optional UTF-8 BOM (U+FEFF) so Windows-saved files are not silently
  // skipped. Normalise CRLF -> LF so both line-ending styles are handled by a single
  // set of regexes.
  const normalised = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

  const frontmatter = /^---\n(?<frontmatter>[\s\S]*?)\n---/.exec(normalised)
    ?.groups?.['frontmatter'];
  if (!frontmatter) return null;

  // Match `source: <value>` regardless of trailing whitespace or inline content.
  // The value itself may contain whitespace before a `#` comment.
  const rawSource = /^source:\s*(?<source>[^\n#]+)/m.exec(frontmatter)
    ?.groups?.['source'];
  const source = rawSource?.trim().replace(/^['"]|['"]$/g, '');
  // Match `scope:` whether the value is empty, inline (`scope: { ... }`), or a
  // nested block (next line is indented). Any non-whitespace/comment after the colon
  // counts as content -- we only care that the key is present.
  const hasScope = /^scope\s*:/m.test(frontmatter);
  // Same broadening for `watch:` -- present in any form means the author already
  // migrated, so we suppress the hint.
  const hasWatch = /^watch\s*:/m.test(frontmatter);
  if (!source || !hasScope || hasWatch) return null;

  return `did you mean to use the current watch shape? Move source/scope into watch:, for example: watch: { type: ${source}, ... }`;
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

    // Validate watch.type names and per-source config against source-specific schemas
    const scopeErrors: { id: string; errors: string[] }[] = [];
    const validMonitors = result.monitors.filter((m) => {
      const sourceName = m.monitor.frontmatter.watch.type;
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

      // Extract per-source config (watch block minus `type`) for schema validation
      const { type: _type, ...watchConfig } = m.monitor.frontmatter.watch;
      const errors = validateScope(watchConfig, source.scopeSchema);

      // BP3 (003 §12): a keyed-collection block is only valid under json-diff. The
      // generated schema already rejects it, but cfworker's generic message
      // ("Instance does not match json-diff") is opaque -- surface the actionable
      // wording instead. This rule is source-agnostic (any source exposing
      // `change-detection`), so it lives in the shared validate path rather than a
      // per-source schema.
      const collectionError = changeDetectionCollectionError(watchConfig);
      const allScopeErrors = collectionError
        ? [collectionError, ...errors.filter((e) => !e.includes('then'))]
        : errors;

      if (allScopeErrors.length > 0) {
        scopeErrors.push({ id: m.monitor.id, errors: allScopeErrors });
        return false;
      }
      return true;
    });

    // Duplicate folder-derived ids are a tree-level correctness error (SP2),
    // independent of whether each file parses.
    const duplicateErrors = result.duplicateIds.map((dup) => ({
      filePath: dup.filePaths.join(', '),
      error: `Duplicate monitor id "${dup.id}" -- ids are derived from folder names and must be unique within a tree`,
    }));

    const allErrors = [
      ...result.errors.map((e) => ({
        // Use the monitor ID (derived from the folder/stem name) rather than the
        // full file path so error output is consistent with valid-monitor output,
        // which already uses the ID. Fall back to the file path if ID derivation
        // returns an empty/dot-prefixed string (e.g. an unusual path).
        filePath: monitorIdFromPath(e.filePath) || e.filePath,
        error: [e.error, oldSourceScopeShapeHint(e.filePath)]
          .filter(Boolean)
          .join('; '),
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
          name: m.monitor.displayName,
          source: m.monitor.frontmatter.watch.type,
        })),
        duplicateIds: result.duplicateIds,
        errors: allErrors,
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      if (validMonitors.length > 0) {
        console.log(`Valid monitors: ${String(validMonitors.length)}`);
        for (const m of validMonitors) {
          console.log(`  ${m.monitor.id}: ${m.monitor.displayName}`);
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
