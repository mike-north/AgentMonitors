/**
 * Nx cache contract for package targets.
 *
 * A cached target replays its recorded result whenever its hash matches, so
 * every file and host facility that can change the result must be part of the
 * hash. These cases read the hash plan Nx itself computes, not nx.json text,
 * so they fail if a named input stops resolving to the files it is meant to
 * cover. Each listed file was observed being read (strace of the real suites)
 * or is referenced by the target's compiler or API Extractor configuration.
 *
 * Uses Nx's HashPlanInspector from the pinned Nx version. If an Nx upgrade
 * moves it, this suite fails loudly rather than silently passing.
 *
 * @see docs/specs/004-validation-testing.md section 2.14
 * @see https://nx.dev/docs/kb/configure-inputs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './publish-release-packages.mjs';

interface Inspector {
  init(): Promise<void>;
  inspectTask(
    target: { project: string; target: string },
    parsedArgs: Record<string, unknown>,
    extraTargetDependencies: undefined,
    excludeTaskDependencies: boolean,
  ): Record<string, string[]>;
}

const SHARED_BUILD_CONFIG = [
  'file:tsconfig.base.json',
  'file:api-extractor.base.json',
  'file:api-extractor.build.json',
];
const TEST_ENVIRONMENT = 'runtime:node scripts/nx-test-environment.mjs';
const DOCKER_ENVIRONMENT =
  'runtime:node scripts/nx-test-environment.mjs --docker';

let inspector: Inspector;

function plan(project: string, target: string): string[] {
  const result = inspector.inspectTask(
    { project, target },
    {},
    undefined,
    true,
  );
  const items = result[`${project}:${target}`];
  if (!items) throw new Error(`no hash plan for ${project}:${target}`);
  return items;
}

beforeAll(async () => {
  process.env['NX_DAEMON'] = 'false';
  const requireFromRoot = createRequire(path.join(REPO_ROOT, 'package.json'));
  const { createProjectGraphAsync } = requireFromRoot(
    'nx/src/project-graph/project-graph',
  ) as {
    createProjectGraphAsync(opts: { exitOnError: boolean }): Promise<unknown>;
  };
  const { HashPlanInspector } = requireFromRoot(
    'nx/src/hasher/hash-plan-inspector',
  ) as { HashPlanInspector: new (graph: unknown, root: string) => Inspector };
  const previous = process.cwd();
  process.chdir(REPO_ROOT);
  try {
    const graph = await createProjectGraphAsync({ exitOnError: false });
    inspector = new HashPlanInspector(graph, REPO_ROOT);
    await inspector.init();
  } finally {
    process.chdir(previous);
  }
}, 120_000);

describe('shared compiler and API Extractor configuration', () => {
  it.each([
    ['@agentmonitors/core', 'build'],
    ['@agentmonitors/core', 'check'],
    ['@agentmonitors/core', 'check:api-report'],
    ['@agentmonitors/cli', 'build'],
    ['@agentmonitors/cli', 'check'],
    ['@agentmonitors/source-command-poll', 'build'],
  ])('%s:%s hashes the root tsconfig and API Extractor configs', (p, t) => {
    expect(plan(p, t)).toEqual(expect.arrayContaining(SHARED_BUILD_CONFIG));
  });

  it('check:api-report also hashes the report-mode config', () => {
    expect(plan('@agentmonitors/core', 'check:api-report')).toContain(
      'file:api-extractor.report.json',
    );
  });

  it('a consumer check hashes upstream sources whose declarations it reads', () => {
    expect(plan('@agentmonitors/cli', 'check')).toContain(
      'file:libs/core/src/index.ts',
    );
  });
});

describe('test inputs outside the owning project', () => {
  it('core tests hash every file the signal inventory reads', () => {
    expect(plan('@agentmonitors/core', 'test')).toEqual(
      expect.arrayContaining([
        'file:docs/specs/008-reliability-process-hygiene.md',
        'file:apps/cli/src/index.ts',
        'file:plugins/source-command-poll/src/self-bound.ts',
      ]),
    );
  });

  it('CLI tests hash the agent plugin and owned-process helpers they load', () => {
    for (const target of ['test', 'test:serial']) {
      expect(plan('@agentmonitors/cli', target)).toEqual(
        expect.arrayContaining([
          'file:agent-plugins/agentmonitors/hooks/hooks.json',
          'file:agent-plugins/agentmonitors/skills/setup-monitors/SKILL.md',
          'file:scripts/owned-test-group.mjs',
          'file:scripts/owned-worker-terminated.mjs',
        ]),
      );
    }
  });

  it('the Docker smoke suite hashes the workspace install inputs it copies', () => {
    expect(plan('@agentmonitors/cli', 'test:serial')).toEqual(
      expect.arrayContaining([
        'file:package.json',
        'file:pnpm-lock.yaml',
        'file:pnpm-workspace.yaml',
      ]),
    );
  });
});

describe('host facilities that change what a suite exercises', () => {
  it.each([
    '@agentmonitors/core',
    '@agentmonitors/cli',
    '@agentmonitors/source-command-poll',
    '@agentmonitors/source-incoming-changes',
    'agentmonitors',
  ])('%s:test hashes test isolation and the host fingerprint', (project) => {
    expect(plan(project, 'test')).toEqual(
      expect.arrayContaining([
        'file:scripts/test-isolation/config.mjs',
        'file:scripts/nx-test-environment.mjs',
        TEST_ENVIRONMENT,
      ]),
    );
  });

  it('the serial suite also hashes Docker reachability', () => {
    expect(plan('@agentmonitors/cli', 'test:serial')).toEqual(
      expect.arrayContaining([
        'file:scripts/test-isolation/config.mjs',
        DOCKER_ENVIRONMENT,
      ]),
    );
  });
});

describe('host fingerprint script', () => {
  const script = path.join(REPO_ROOT, 'scripts/nx-test-environment.mjs');
  const run = (args: string[], env: NodeJS.ProcessEnv): unknown =>
    JSON.parse(
      execFileSync(process.execPath, [script, ...args], {
        cwd: REPO_ROOT,
        env,
        encoding: 'utf8',
      }),
    );

  it('reports jq as unavailable when it is not on PATH', () => {
    // A PATH holding only node: jq and docker cannot resolve.
    const bin = mkdtempSync(path.join(tmpdir(), 'nx-fingerprint-'));
    try {
      symlinkSync(process.execPath, path.join(bin, 'node'));
      const env = { PATH: bin };
      expect(run([], env)).toEqual({
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        jq: 'unavailable',
        ci: 'unset',
      });
      expect(run(['--docker'], { ...env, CI: 'true' })).toMatchObject({
        jq: 'unavailable',
        ci: 'set',
        docker: 'unavailable',
      });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('is deterministic for an unchanged host', () => {
    const env = { ...process.env };
    expect(run([], env)).toEqual(run([], env));
  });
});
