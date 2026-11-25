/**
 * API report validation consumes declarations owned by build. These checks guard
 * the command, resolved Extractor configuration and task ordering together so a
 * report check cannot become a second writer of published declarations.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ExtractorConfig } from '@microsoft/api-extractor';
import { describe, expect, it } from 'vitest';

/** Published TypeScript entry points that participate in report validation. */
const packageDirs = [
  'libs/core',
  'plugins/source-api-poll',
  'plugins/source-command-poll',
  'plugins/source-file-fingerprint',
  'plugins/source-incoming-changes',
  'plugins/source-schedule',
];
const root = path.resolve(import.meta.dirname, '..');

/** Read workspace configuration without relying on the caller's directory. */
function readJson(relativePath: string) {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
}

describe('API report build ownership', () => {
  it.each(packageDirs)(
    '%s checks existing declarations without emitting rollups',
    (dir) => {
      const pkg = readJson(`${dir}/package.json`);
      expect(pkg.scripts['check:api-report']).toBe(
        'api-extractor run --verbose -c api-extractor.report.json',
      );
      const report = reportConfig(dir, 'report');
      expect(report.apiReportEnabled).toBe(true);
      expect(report.rollupEnabled).toBe(false);
      const build = reportConfig(dir, 'build');
      expect(build.apiReportEnabled).toBe(false);
      expect(build.rollupEnabled).toBe(true);
      expect(build.publicTrimmedFilePath).toBe(
        path.join(root, dir, 'dist/public.d.ts'),
      );
    },
  );

  it('orders each check after its own build and upstream builds', () => {
    expect(
      readJson('nx.json').targetDefaults['check:api-report'].dependsOn,
    ).toEqual(['build', '^build']);
  });

  it('allows concurrent report checks in both workspace entry points', () => {
    const scripts = readJson('package.json').scripts;
    expect(scripts['check:api-report']).not.toContain('--parallel=1');
    const reportLeg = scripts.affected
      .split('&&')
      .find((leg: string) => leg.includes('-t check:api-report'));
    expect(reportLeg).toBeDefined();
    expect(reportLeg).not.toContain('--parallel=1');
  });
});

/** Resolve inherited settings without requiring build artifacts for a config-only test. */
function reportConfig(dir: string, mode: 'report' | 'build'): ExtractorConfig {
  const configPath = path.join(root, dir, `api-extractor.${mode}.json`);
  return ExtractorConfig.prepare({
    configObject: ExtractorConfig.loadFile(configPath),
    configObjectFullPath: configPath,
    ignoreMissingEntryPoint: true,
  });
}
