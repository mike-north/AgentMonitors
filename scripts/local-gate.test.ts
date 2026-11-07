/**
 * The pre-push gate must cover CI's portable validation commands. Read the
 * actual workflow and package scripts so adding a CI step requires a local
 * counterpart or an explicit, reviewed environment exclusion (004 §2.10).
 * These tests deliberately reject unfamiliar shell syntax rather than infer
 * that a command hidden in a conditional or an echo will actually execute.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/** Only the workflow fields relevant to execution and failure propagation. */
interface IStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly if?: unknown;
  readonly 'continue-on-error'?: unknown;
}

/** Jobs are classified explicitly; a new job must not disappear from the audit. */
interface IWorkflow {
  readonly jobs: Record<
    string,
    {
      readonly steps: readonly IStep[];
      readonly 'runs-on'?: string;
      readonly if?: unknown;
      readonly 'continue-on-error'?: unknown;
    }
  >;
}

/** Root commands are the shared entry points used by both CI and contributors. */
interface IPackage {
  readonly scripts: Record<string, string>;
}

const root = resolve(import.meta.dirname, '..');
const workflow: IWorkflow = parse(
  readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
);
const pkg: IPackage = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
);

/**
 * Reviewed exceptions, not a blanket ignore list. Pin each excluded job's
 * executable steps so an added validation step cannot silently stay CI-only.
 * Filters use GitHub event SHAs/outputs; Windows needs its own OS; website
 * coverage is a separately owned gate intentionally excluded from the root.
 */
const ciOnly: Readonly<Record<string, readonly string[]>> = {
  'release-collateral-changed': [
    'Check for release-collateral-relevant changes',
  ],
  'website-changed': ['Check for website changes'],
  'windows-install-check': [
    'pnpm exec nx run-many --target=build --exclude=agentmonitors-workspace,@agentmonitors/website',
    'pnpm test:windows-install',
  ],
  'website-link-check': [
    'pnpm --filter @agentmonitors/website build',
    'pnpm --filter @agentmonitors/website run check:links',
  ],
};

/** Compare fail-closed command chains, preserving the serial suite's isolation. */
function assertLocalGate(
  candidate: IWorkflow,
  scripts: IPackage['scripts'],
): void {
  // Inherited defaults and environment can change every command's meaning.
  // Unrecognized workflow fields require a coverage decision, rather than
  // assuming that identical command text implies identical execution.
  for (const key of Object.keys(candidate)) {
    expect(['name', 'on', 'jobs']).toContain(key);
  }
  expect(Object.keys(candidate.jobs).sort()).toEqual(
    ['test', 'publish-dry-run', ...Object.keys(ciOnly)].sort(),
  );
  const commands: string[] = [];
  // CI job mappings are unordered. Derive the local sequence from the test
  // job before release validation, while preserving step order within each.
  for (const id of ['test', 'publish-dry-run', ...Object.keys(ciOnly)]) {
    const job = candidate.jobs[id];
    if (!(id in ciOnly)) {
      // Portable commands assume the root checkout on CI's Ubuntu host.
      // Defaults, environment, containers, services, and matrices need an
      // explicit local equivalent before they can share that assumption.
      for (const key of Object.keys(job)) {
        expect([
          'name',
          'runs-on',
          'timeout-minutes',
          'steps',
          'needs',
          'if',
        ]).toContain(key);
      }
      expect(job['runs-on']).toBe('ubuntu-latest');
    }
    // Provisioning actions are prerequisites, not validation. An unfamiliar
    // action may run checks, so it needs the same explicit coverage decision
    // as a new shell step instead of being silently filtered out.
    for (const step of job.steps) {
      if (!(id in ciOnly)) {
        // Validate execution context before filtering setup or deduplicating
        // commands. Installation and action steps can also affect checks.
        const allowed =
          step.uses === undefined ? ['name', 'run'] : ['name', 'uses', 'with'];
        for (const key of Object.keys(step)) {
          expect(allowed).toContain(key);
        }
      }
      if (step.uses !== undefined) {
        expect(step.uses).toMatch(
          /^(actions\/checkout|pnpm\/action-setup|actions\/setup-node)@[^\s]+$/,
        );
      } else {
        expect(step.run).toBeTypeOf('string');
      }
    }
    const runs = job.steps.filter(
      (step) =>
        step.run !== undefined && step.run !== 'pnpm install --frozen-lockfile',
    );
    if (id in ciOnly) {
      expect(
        runs.map((step) => (id.endsWith('-changed') ? step.name : step.run)),
      ).toEqual(ciOnly[id]);
      continue;
    }
    if (id === 'test') {
      expect(job).not.toHaveProperty('if');
      // A skipped prerequisite skips this job even without an explicit if.
      expect(job).not.toHaveProperty('needs');
    }
    expect(job).not.toHaveProperty('continue-on-error');
    for (const step of runs) {
      expect(step).not.toHaveProperty('if');
      expect(step).not.toHaveProperty('continue-on-error');
      expect(step.run).toMatch(/^pnpm [a-z][a-z0-9:-]*$/);
      commands.push(step.run ?? '');
    }
  }
  // The issue's required outcomes cannot vanish from both sides together.
  for (const name of [
    'check',
    'check:api-report',
    'test',
    'test:serial',
    'test:scripts',
    'test:standalone-consumer',
    'test:e2e-fresh-install-hooks',
  ]) {
    expect(
      candidate.jobs.test.steps.some((step) => step.run === `pnpm ${name}`),
    ).toBe(true);
  }
  expect(commands).toContain('pnpm build');
  expect(commands).toContain('pnpm publish:packages:dry-run');
  // Build first, then CI's test sequence, then the publish guard. CI repeats
  // test:scripts in its separate job; one execution covers both obligations.
  const expected = [
    'pnpm build',
    ...new Set(commands.filter((command) => command !== 'pnpm build')),
  ];
  expect(scripts.verify?.split(/\s*&&\s*/)).toEqual(expected);
  for (const command of expected) {
    expect(scripts[command.slice('pnpm '.length)]).toBeTruthy();
  }
}

/** A complete fixture derived from CI, independent of whether verify exists yet. */
const completeScripts = {
  ...pkg.scripts,
  verify:
    'pnpm build && pnpm check && pnpm check:api-report && pnpm test && pnpm test:serial && pnpm test:scripts && pnpm test:standalone-consumer && pnpm test:e2e-fresh-install-hooks && pnpm publish:packages:dry-run',
};

describe('local verification gate (issue #458)', () => {
  it('covers the real CI workflow from the documented root command', () => {
    assertLocalGate(workflow, pkg.scripts);
  });

  it('accepts the complete portable gate', () => {
    assertLocalGate(workflow, completeScripts);
  });

  it.each([
    { 'working-directory': 'apps/website' },
    { shell: 'bash --noprofile --norc {0}' },
    { env: { NODE_ENV: 'production' } },
  ])(
    'rejects a duplicate command in an unfamiliar step context: %j',
    (context) => {
      const changed = structuredClone(workflow);
      changed.jobs.test = {
        ...changed.jobs.test,
        steps: [...changed.jobs.test.steps, { run: 'pnpm check', ...context }],
      };
      expect(() => assertLocalGate(changed, completeScripts)).toThrow();
    },
  );

  it.each([
    { defaults: { run: { 'working-directory': 'apps/website' } } },
    { env: { NODE_ENV: 'production' } },
  ])('rejects unfamiliar inherited workflow contexts: %j', (context) => {
    expect(() =>
      assertLocalGate({ ...workflow, ...context }, completeScripts),
    ).toThrow();
  });

  it.each([
    { defaults: { run: { 'working-directory': 'apps/website' } } },
    { env: { NODE_ENV: 'production' } },
    { container: 'node:24' },
    { services: { database: { image: 'postgres' } } },
    { strategy: { matrix: { mode: ['production'] } } },
    { 'runs-on': 'windows-latest' },
  ])('rejects unfamiliar portable job contexts: %j', (context) => {
    const changed = structuredClone(workflow);
    changed.jobs.test = { ...changed.jobs.test, ...context };
    expect(() => assertLocalGate(changed, completeScripts)).toThrow();
  });

  it('accepts equivalent workflows regardless of job mapping order', () => {
    // YAML job order does not schedule CI. In particular, release validation
    // appearing before the test job must not reorder the local test chain.
    assertLocalGate(
      { jobs: Object.fromEntries(Object.entries(workflow.jobs).reverse()) },
      completeScripts,
    );
  });

  it('rejects prerequisites that can skip the mandatory test job', () => {
    const changed = structuredClone(workflow);
    const job = { ...changed.jobs.test, needs: 'website-link-check' };
    changed.jobs.test = job;
    expect(() => assertLocalGate(changed, completeScripts)).toThrow();
  });

  it('rejects the old build/check/test gate', () => {
    expect(() =>
      assertLocalGate(workflow, {
        ...pkg.scripts,
        verify: 'pnpm build && pnpm check && pnpm test',
      }),
    ).toThrow();
  });

  it.each([
    'test:serial',
    'test:standalone-consumer',
    'check:api-report',
    'test:scripts',
    'test:e2e-fresh-install-hooks',
    'publish:packages:dry-run',
  ])('rejects omission of %s locally', (name) => {
    expect(() =>
      assertLocalGate(workflow, {
        ...completeScripts,
        verify: completeScripts.verify
          .split(' && ')
          .filter((command) => command !== `pnpm ${name}`)
          .join(' && '),
      }),
    ).toThrow();
  });

  it('rejects a newly added CI command missing locally', () => {
    const changed = structuredClone(workflow);
    changed.jobs.test = {
      ...changed.jobs.test,
      steps: [...changed.jobs.test.steps, { run: 'pnpm test:new-suite' }],
    };
    expect(() => assertLocalGate(changed, completeScripts)).toThrow();
  });

  it('requires a decision for new jobs and new steps in excluded jobs', () => {
    const changed = structuredClone(workflow);
    changed.jobs.newJob = { steps: [{ run: 'pnpm test:new-suite' }] };
    expect(() => assertLocalGate(changed, completeScripts)).toThrow();
    delete changed.jobs.newJob;
    changed.jobs['windows-install-check'] = {
      steps: [{ run: 'pnpm test:new-suite' }],
    };
    expect(() => assertLocalGate(changed, completeScripts)).toThrow();
  });

  it('requires a coverage decision for an unfamiliar action', () => {
    const changed = structuredClone(workflow);
    changed.jobs.test = {
      ...changed.jobs.test,
      steps: [...changed.jobs.test.steps, { uses: 'example/validation@v1' }],
    };
    expect(() => assertLocalGate(changed, completeScripts)).toThrow();
  });

  it('rejects reordering the local serial suite ahead of the parallel suite', () => {
    expect(() =>
      assertLocalGate(workflow, {
        ...completeScripts,
        verify: completeScripts.verify.replace(
          'pnpm test && pnpm test:serial',
          'pnpm test:serial && pnpm test',
        ),
      }),
    ).toThrow();
  });

  it.each([{ if: false }, { 'continue-on-error': true }])(
    'rejects weakened CI steps: %j',
    (weakening) => {
      const changed = structuredClone(workflow);
      changed.jobs.test = {
        ...changed.jobs.test,
        steps: changed.jobs.test.steps.map((step) =>
          step.run === 'pnpm test:serial' ? { ...step, ...weakening } : step,
        ),
      };
      expect(() => assertLocalGate(changed, completeScripts)).toThrow();
    },
  );

  it.each([' || true', ' &', '; echo success'])(
    'rejects local failure masking or concurrency: %s',
    (suffix) => {
      expect(() =>
        assertLocalGate(workflow, {
          ...completeScripts,
          verify: completeScripts.verify + suffix,
        }),
      ).toThrow();
    },
  );

  it('keeps the fast suite and names its omissions in an executable notice', () => {
    const [notice, test] = pkg.scripts.test.split(' && ');
    expect(notice).toMatch(/^echo '[^']+'$/);
    for (const name of [
      'test:serial',
      'test:scripts',
      'test:standalone-consumer',
      'test:e2e-fresh-install-hooks',
      'pnpm verify',
    ]) {
      expect(notice).toContain(name);
    }
    expect(test).toBe(
      'NX_TUI=false nx run-many --target=test --exclude=agentmonitors-workspace',
    );
  });
});

/** The advisory gate has its own security cadence, separate from ci.yml parity. */
const independentAudit = {
  path: '.github/workflows/dependency-audit.yml',
  command: 'pnpm check:dependency-audit',
  reason:
    'Independent scheduled production-advisory audit; run separately from pnpm verify.',
};
const auditWorkflow: IWorkflow = parse(
  readFileSync(resolve(root, independentAudit.path), 'utf8'),
);

/** Require an explicit decision when the excluded portable audit surface changes. */
function assertIndependentAudit(candidate: IWorkflow): void {
  expect(Object.keys(candidate.jobs)).toEqual(['dependency-audit']);
  for (const key of Object.keys(candidate)) {
    expect(['name', 'on', 'jobs']).toContain(key);
  }
  const job = candidate.jobs['dependency-audit'];
  for (const key of Object.keys(job)) {
    expect(['name', 'runs-on', 'timeout-minutes', 'steps']).toContain(key);
  }
  expect(job['runs-on']).toBe('ubuntu-latest');
  for (const step of job.steps) {
    for (const key of Object.keys(step)) {
      expect(
        step.uses === undefined ? ['name', 'run'] : ['name', 'uses', 'with'],
      ).toContain(key);
    }
    if (step.uses !== undefined) {
      expect(step.uses).toMatch(
        /^(actions\/checkout|pnpm\/action-setup|actions\/setup-node)@[^\s]+$/,
      );
    }
  }
  expect(
    job.steps.flatMap((step) => (step.run === undefined ? [] : [step.run])),
  ).toEqual(['pnpm install --frozen-lockfile', independentAudit.command]);
}

describe('independent production audit exclusion', () => {
  it('classifies the actual workflow and keeps its live command separate', () => {
    assertIndependentAudit(auditWorkflow);
    expect(independentAudit.reason).toContain('scheduled');
    expect(pkg.scripts.verify).not.toContain(independentAudit.command);
    expect(pkg.scripts['check:dependency-audit']).toBe(
      'node scripts/check-dependency-audit.mjs',
    );
  });

  it.each([
    { run: 'pnpm check:new-audit' },
    { run: 'pnpm check:dependency-audit', 'working-directory': 'apps/website' },
  ])('requires a decision for an extra excluded audit step: %j', (step) => {
    const changed = structuredClone(auditWorkflow);
    changed.jobs['dependency-audit'] = {
      ...changed.jobs['dependency-audit'],
      steps: [...changed.jobs['dependency-audit'].steps, step],
    };
    expect(() => assertIndependentAudit(changed)).toThrow();
  });

  it('rejects removing the live audit command', () => {
    const changed = structuredClone(auditWorkflow);
    changed.jobs['dependency-audit'] = {
      ...changed.jobs['dependency-audit'],
      steps: changed.jobs['dependency-audit'].steps.filter(
        (step) => step.run !== independentAudit.command,
      ),
    };
    expect(() => assertIndependentAudit(changed)).toThrow();
  });
});
