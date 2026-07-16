import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  scanMonitors,
  SourceRegistry,
  validateWatchScope,
} from '@agentmonitors/core';
import { registerCoreSources } from '../sources.js';
import { requireDirectory } from '../validation.js';
import {
  COMMAND_POLL_SCAFFOLD_WARNING,
  isUntouchedCommandPollDefault,
} from './scaffold-defaults.js';

/**
 * Derive the monitor ID from a file path, mirroring the logic in parseMonitor
 * exactly — including the empty/dot-prefixed guard. Returns an empty string
 * when the ID cannot be safely derived so the caller can fall back to the full
 * file path (matching parseMonitor's "Could not derive a monitor id" error path).
 */
function monitorIdFromPath(filePath: string): string {
  const base = path.basename(filePath);
  const id =
    base === 'MONITOR.md'
      ? path.basename(path.dirname(filePath))
      : path.parse(filePath).name;
  // Mirror parseMonitor's guard: reject empty or dot-prefixed ids (e.g. '.foo').
  if (!id || id.startsWith('.')) return '';
  return id;
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
    // Soft warnings: advisory notes on a *valid* monitor (they never mark it
    // invalid or change the exit code). Currently: a command-poll scaffold left
    // at its untouched default `command:` (issue #388).
    const warnings: { id: string; warning: string }[] = [];
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

      // Extract per-source config (watch block minus `type`) for schema
      // validation. `validateWatchScope` is the shared core helper — schema
      // check plus the BP3 `change-detection.collection` friendly wrapper (003
      // §12) — so `validate` and the ephemeral `watch declare` path (007 §4.2)
      // reject an invalid scope with the identical diagnosis (005 §14.4).
      const { type: _type, ...watchConfig } = m.monitor.frontmatter.watch;
      const allScopeErrors = validateWatchScope(
        watchConfig,
        source.scopeSchema,
      );

      if (allScopeErrors.length > 0) {
        scopeErrors.push({ id: m.monitor.id, errors: allScopeErrors });
        return false;
      }

      // The monitor is valid, but a command-poll scaffold whose `command:` is
      // still the untouched `init` default watches the wrong thing for any
      // intent other than upstream-tip polling — flag it so a wrong-intent ship
      // is caught instead of silently passing as configured (issue #388).
      if (
        sourceName === 'command-poll' &&
        isUntouchedCommandPollDefault(watchConfig['command'])
      ) {
        warnings.push({
          id: m.monitor.id,
          warning: COMMAND_POLL_SCAFFOLD_WARNING,
        });
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
        // Additive, non-fatal advisories (issue #388). Empty when none apply;
        // existing consumers that ignore unknown keys are unaffected.
        warnings,
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

      if (warnings.length > 0) {
        console.log(`\nWarnings: ${String(warnings.length)}`);
        for (const w of warnings) {
          console.log(`  ${w.id}: ${w.warning}`);
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
