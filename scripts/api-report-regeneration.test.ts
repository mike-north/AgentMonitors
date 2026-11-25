/**
 * Workspace report regeneration must preserve build-owned declarations. A
 * private copy of the real built packages exercises the complete Nx workflow
 * without allowing a failed regeneration to corrupt the checkout's reports.
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { hasApiExtractorConfigs } from './api-report-ci-wiring.mjs';
import { PACKAGE_DIRS } from './publish-release-packages.mjs';
import { runJqTestChild } from './run-jq-test-child.mjs';

const root = path.resolve(import.meta.dirname, '..');

it('workspace regeneration preserves unchanged reports and published declaration entry points', async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'api-report-workspace-'));
  const packageDirs = PACKAGE_DIRS.filter(hasApiExtractorConfigs);
  try {
    // The copied sources, configs and build output are the real workspace
    // inputs. Dependency links are read-only; all generated output stays here.
    for (const file of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'nx.json',
      '.gitignore',
      'tsconfig.base.json',
      'api-extractor.base.json',
      'api-extractor.build.json',
      'api-extractor.report.json',
    ]) {
      cpSync(path.join(root, file), path.join(fixture, file));
    }
    symlinkSync(
      path.join(root, 'node_modules'),
      path.join(fixture, 'node_modules'),
      'junction',
    );
    const reports = new Map<string, Buffer>();
    for (const dir of packageDirs) {
      const source = path.join(root, dir);
      expect(
        existsSync(path.join(source, 'dist/public.d.ts')),
        `${dir} must be built first`,
      ).toBe(true);
      cpSync(source, path.join(fixture, dir), {
        recursive: true,
        filter: (file) =>
          !['node_modules', 'temp'].includes(path.basename(file)),
      });
      symlinkSync(
        path.join(source, 'node_modules'),
        path.join(fixture, dir, 'node_modules'),
        'junction',
      );
      for (const file of readdirSync(path.join(source, 'api-report'))) {
        if (file.endsWith('.api.md')) {
          const relative = path.join(dir, 'api-report', file);
          reports.set(relative, readFileSync(path.join(fixture, relative)));
        }
      }
    }
    expect(reports.size).toBe(6);
    expect(existsSync(path.join(fixture, 'libs/core/dist/rollup.d.ts'))).toBe(
      true,
    );

    // Keep pnpm and every Nx/build descendant inside the existing owned-group
    // cleanup boundary, including when execution or pipe closure times out.
    const runner = path.join(fixture, 'regenerate.mjs');
    writeFileSync(
      runner,
      [
        "import { spawnSync } from 'node:child_process';",
        "const result = spawnSync('pnpm', ['fix:api-report'], { stdio: 'inherit' });",
        'if (result.error) throw result.error;',
        'process.exit(result.status ?? 1);',
      ].join('\n'),
    );
    const result = await runJqTestChild([runner], {
      cwd: fixture,
      env: {
        ...process.env,
        NX_PARALLEL: '1',
        // This is deliberately not an installed checkout. Never let pnpm
        // reconcile the shared installation used by the fixture's links.
        pnpm_config_verify_deps_before_run: 'warn',
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      },
      timeout: 90_000,
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    for (const [relative, before] of reports) {
      expect
        .soft(readFileSync(path.join(fixture, relative)), relative)
        .toEqual(before);
    }
    for (const dir of packageDirs) {
      expect
        .soft(existsSync(path.join(fixture, dir, 'dist/public.d.ts')), dir)
        .toBe(true);
    }
    expect
      .soft(existsSync(path.join(fixture, 'libs/core/dist/rollup.d.ts')))
      .toBe(true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 120_000);
