/**
 * Pin the authored match sets across monitor discovery and file observation.
 * Patterns come from the shipped scaffold, scanner contract (001 §2), and
 * documented file-fingerprint examples (003 §3), rather than a replacement
 * matcher whose behavior could drift along with the dependency being checked.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TEMPLATES } from '../apps/cli/src/commands/init.js';
import { isLiteralGlob } from '../apps/cli/src/verify-budget.js';
import { parseMonitor } from '../libs/core/src/parser/parse-monitor.js';
import { scanMonitors } from '../libs/core/src/parser/scan-monitors.js';
import source from '../plugins/source-file-fingerprint/src/index.js';

/** Every fixture belongs to this suite and is isolated from actual monitors. */
const roots: string[] = [];

/** Materialize an explicit file inventory so assertions include nonmatches. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'glob-compatibility-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

/** Inspect persisted source state, not only zero-observation baseline output. */
async function matchedFiles(
  root: string,
  config: Record<string, unknown>,
): Promise<string[]> {
  const result = await source.observe(config, {
    now: new Date('2026-01-01T00:00:00Z'),
    workspacePath: root,
  });
  expect(result.observations).toEqual([]);
  const state = result.nextState as { fingerprints: Record<string, string> };
  return Object.keys(state.fingerprints)
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .sort();
}

describe('authored glob compatibility', () => {
  it('scans the actual bundled presets in flat and nested forms, excluding hidden definitions and assets', async () => {
    const content = TEMPLATES['file-fingerprint'];
    if (!content) throw new Error('Missing file-fingerprint preset');
    const files: Record<string, string> = {};
    for (const [name, content] of Object.entries(TEMPLATES)) {
      files[`nested/${name}/MONITOR.md`] = content;
      files[`flat-${name}.md`] = content;
      files[`nested/${name}/notes.md`] = content;
      files[`.hidden/${name}/MONITOR.md`] = content;
      files[`.${name}.md`] = content;
    }
    // A root-level MONITOR.md is explicitly outside scanner identity rules.
    files['MONITOR.md'] = content;
    const root = fixture(files);
    const result = await scanMonitors(root);
    expect(result.errors).toEqual([]);
    expect(result.duplicateIds).toEqual([]);
    expect(result.monitors.map(({ monitor }) => monitor.id).sort()).toEqual(
      Object.keys(TEMPLATES)
        .flatMap((name) => [name, `flat-${name}`])
        .sort(),
    );
  });

  it('fingerprints the exact recursive TypeScript pattern supplied by the bundled preset', async () => {
    const content = TEMPLATES['file-fingerprint'];
    if (!content) throw new Error('Missing file-fingerprint preset');
    const root = fixture({
      'top.ts': 'top',
      'src/deep/code.ts': 'nested',
      'src/generated-api.ts': 'generated',
      '.hidden.ts': 'hidden file',
      'src/.hidden/code.ts': 'hidden directory',
      'src/readme.md': 'other extension',
    });
    const parsed = parseMonitor(content, path.join(root, 'preset/MONITOR.md'));
    if (!parsed.ok) throw new Error(parsed.error);
    const watch = parsed.monitor.frontmatter.watch;
    expect(watch.globs).toEqual(['**/*.ts']);
    expect(await matchedFiles(root, watch)).toEqual([
      'src/deep/code.ts',
      'src/generated-api.ts',
      'top.ts',
    ]);
    // This exclusion is the actual example in 003 §3.1, with the same cwd.
    expect(
      await matchedFiles(root, { ...watch, ignore: ['**/generated-*.ts'] }),
    ).toEqual(['src/deep/code.ts', 'top.ts']);
  });

  it('agrees with discovery on existing MONITOR.md and flat markdown globs', async () => {
    const content = TEMPLATES['file-fingerprint'];
    if (!content) throw new Error('Missing file-fingerprint preset');
    const root = fixture({
      'one/MONITOR.md': content,
      'nested/two/MONITOR.md': content,
      'flat.md': content,
      'one/notes.md': content,
      '.hidden/MONITOR.md': content,
      '.hidden.md': content,
    });
    const scan = await scanMonitors(root);
    expect(scan.errors).toEqual([]);
    const discovered = scan.monitors
      .map(({ monitor }) =>
        path.relative(root, monitor.filePath).split(path.sep).join('/'),
      )
      .sort();
    expect(discovered).toEqual([
      'flat.md',
      'nested/two/MONITOR.md',
      'one/MONITOR.md',
    ]);
    expect(
      await matchedFiles(root, { globs: ['**/MONITOR.md', '*.md'] }),
    ).toEqual(discovered);
  });

  it('keeps default dot exclusion and directory filtering for the existing docs/** example', async () => {
    const root = fixture({
      'docs/readme.md': 'visible',
      'docs/sub/nested.md': 'nested',
      'docs/.hidden.md': 'hidden file',
      'docs/.hidden/nested.md': 'hidden directory',
      'docs/generated/out.md': 'ignored',
    });
    mkdirSync(path.join(root, 'docs/empty'));
    expect(
      await matchedFiles(root, {
        globs: ['docs/**'],
        ignore: ['docs/generated/**'],
      }),
    ).toEqual(['docs/readme.md', 'docs/sub/nested.md']);
    expect(
      await matchedFiles(root, {
        globs: [`${root.split(path.sep).join('/')}/docs/**`],
        ignore: ['docs/generated/**'],
      }),
    ).toEqual(['docs/readme.md', 'docs/sub/nested.md']);
  });

  it('retains glob escape semantics rather than treating backslashes as separators', async () => {
    // glob patterns use forward slashes on every platform; verify classifies
    // the very same escaped pattern that file-fingerprint expands.
    const root = fixture({ 'docs/readme.md': 'visible' });
    expect(await matchedFiles(root, { globs: ['docs/*.md'] })).toEqual([
      'docs/readme.md',
    ]);
    expect(
      await matchedFiles(root, { globs: [String.raw`docs\*.md`] }),
    ).toEqual([]);
    expect(isLiteralGlob(String.raw`docs\*.md`)).toBe(true);
    expect(isLiteralGlob('docs/*.md')).toBe(false);
  });
});
