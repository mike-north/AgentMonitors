/**
 * Tests for the API-report CI-wiring guard (issue #285):
 * `.github/workflows/ci.yml`'s unconditional "Check And Test" (`test`) job
 * must actually run `pnpm check:api-report`. Before this issue, the script
 * existed in `package.json` but nothing in CI invoked it, so a checked-in
 * `api-report/*.api.md` could drift from the real compiled surface
 * indefinitely without ever failing a build. These assertions parse the
 * *real* workflow file with the `yaml` package — the same GitHub-Actions-YAML
 * input contract CI itself consumes — not a hand-built approximation of its
 * shape.
 *
 * @see https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions
 * @see https://eemeli.org/yaml/ (YAML 1.2 core schema: `on:` stays a string key)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  API_REPORT_RUN_MANY_SCRIPTS,
  CI_WORKFLOW_PATH,
  REPO_ROOT,
  ROOT_PACKAGE_JSON_PATH,
  REQUIRED_JOB_ID,
  assertApiReportCheckRuns,
  assertApiReportRunManyIsSerial,
  assertApiReportScriptConfigSplit,
  hasApiExtractorConfigs,
} from './api-report-ci-wiring.mjs';
import { PACKAGE_DIRS } from './publish-release-packages.mjs';

// Reconstruction of ci.yml's "Check And Test" job as it existed immediately
// before issue #285's fix: `check:api-report` was defined in package.json
// but never invoked anywhere in CI. This is the negative-proof fixture —
// the guard MUST reject this shape, proving it would have caught the exact
// gap the issue reported, not just validated whatever the fixed file happens
// to contain.
const PRE_FIX_WORKFLOW_YAML = `
jobs:
  test:
    name: Check And Test
    steps:
      - name: Checkout
        uses: actions/checkout@v5
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Check
        run: pnpm check
      - name: Test
        run: pnpm test
      - name: Test (serial daemon-spawn)
        run: pnpm test:serial
      - name: Test (build script source coverage)
        run: pnpm test:scripts
`;

describe('assertApiReportCheckRuns', () => {
  it('rejects the pre-#285 shape: check:api-report is defined but never invoked', () => {
    const workflow: unknown = parse(PRE_FIX_WORKFLOW_YAML);
    expect(() =>
      assertApiReportCheckRuns(
        workflow as Parameters<typeof assertApiReportCheckRuns>[0],
      ),
    ).toThrow(/never runs `pnpm check:api-report`/);
  });

  it('rejects a workflow missing the required job entirely', () => {
    const workflow: unknown = parse(`
jobs:
  lint:
    steps:
      - run: pnpm check
`);
    expect(() =>
      assertApiReportCheckRuns(
        workflow as Parameters<typeof assertApiReportCheckRuns>[0],
      ),
    ).toThrow(`ci.yml is missing the "${REQUIRED_JOB_ID}" job`);
  });

  it('rejects the check moved into a path-filtered (skippable) job', () => {
    const workflow: unknown = parse(`
jobs:
  test:
    name: Check And Test
    steps:
      - run: pnpm check
      - run: pnpm test
  release-collateral-changed:
    if: github.event_name == 'pull_request'
    steps:
      - run: pnpm check:api-report
`);
    expect(() =>
      assertApiReportCheckRuns(
        workflow as Parameters<typeof assertApiReportCheckRuns>[0],
      ),
    ).toThrow(/never runs `pnpm check:api-report`/);
  });

  it('rejects the required job when it is conditionally skippable', () => {
    const workflow: unknown = parse(`
jobs:
  test:
    name: Check And Test
    if: github.event_name == 'pull_request'
    steps:
      - run: pnpm check:api-report
`);
    expect(() =>
      assertApiReportCheckRuns(
        workflow as Parameters<typeof assertApiReportCheckRuns>[0],
      ),
    ).toThrow(/must run unconditionally/);
  });

  // Regression guard: `if: false` and `if: 0` parse as a boolean/number,
  // not a string, so a `typeof job.if === 'string'` guard silently let them
  // through even though both are GitHub-Actions-falsy and would make this
  // job — and the API report check with it — never run at all.
  it('rejects the required job when its "if" is the boolean false', () => {
    const workflow: unknown = parse(`
jobs:
  test:
    name: Check And Test
    if: false
    steps:
      - run: pnpm check:api-report
`);
    expect(() =>
      assertApiReportCheckRuns(
        workflow as Parameters<typeof assertApiReportCheckRuns>[0],
      ),
    ).toThrow(/must run unconditionally/);
  });

  it('rejects the required job when its "if" is the number 0', () => {
    const workflow: unknown = parse(`
jobs:
  test:
    name: Check And Test
    if: 0
    steps:
      - run: pnpm check:api-report
`);
    expect(() =>
      assertApiReportCheckRuns(
        workflow as Parameters<typeof assertApiReportCheckRuns>[0],
      ),
    ).toThrow(/must run unconditionally/);
  });

  // Regression guard for the same class of gap as #353 (website
  // deploy-workflow guard): a `\b` boundary also matches before `:`, so a
  // differently-named script sharing the `check:api-report` prefix would
  // satisfy a naive guard without ever running the real script.
  it('rejects a check:api-report-lookalike script standing in for the real one', () => {
    const workflow: unknown = parse(`
jobs:
  test:
    name: Check And Test
    steps:
      - run: pnpm check:api-report-legacy
`);
    expect(() =>
      assertApiReportCheckRuns(
        workflow as Parameters<typeof assertApiReportCheckRuns>[0],
      ),
    ).toThrow(/never runs `pnpm check:api-report`/);
  });

  // Regression guard: the job-level `if` check alone doesn't stop a
  // step-level `if:` from silently disabling just the `check:api-report`
  // step while the job (and every other step in it) stays unconditional and
  // green.
  it('rejects a step-level "if" on the check:api-report step, even in an unconditional job', () => {
    const workflow: unknown = parse(`
jobs:
  test:
    name: Check And Test
    steps:
      - run: pnpm check
      - name: Check (API report drift)
        if: github.event_name == 'push'
        run: pnpm check:api-report
      - run: pnpm test
`);
    expect(() =>
      assertApiReportCheckRuns(
        workflow as Parameters<typeof assertApiReportCheckRuns>[0],
      ),
    ).toThrow(/step-level "if:"/);
  });

  // Regression guard: `continue-on-error: true` on just the
  // `check:api-report` step lets that step fail without failing the job —
  // the gate would stay green even while API report drift goes undetected.
  it('rejects "continue-on-error" on the check:api-report step', () => {
    const workflow: unknown = parse(`
jobs:
  test:
    name: Check And Test
    steps:
      - run: pnpm check
      - name: Check (API report drift)
        continue-on-error: true
        run: pnpm check:api-report
      - run: pnpm test
`);
    expect(() =>
      assertApiReportCheckRuns(
        workflow as Parameters<typeof assertApiReportCheckRuns>[0],
      ),
    ).toThrow(/must not set "continue-on-error"/);
  });

  it('accepts a minimal well-formed shape (positive control)', () => {
    const workflow: unknown = parse(`
jobs:
  test:
    name: Check And Test
    steps:
      - run: pnpm check
      - run: pnpm check:api-report
      - run: pnpm test
`);
    expect(() =>
      assertApiReportCheckRuns(
        workflow as Parameters<typeof assertApiReportCheckRuns>[0],
      ),
    ).not.toThrow();
  });

  // The real proof: the actual, on-disk workflow file — parsed exactly as CI
  // would parse it — must satisfy the gate. If a future edit silently drops
  // the `check:api-report` step, moves it into a path-filtered job, or makes
  // the `test` job conditional, this test fails.
  it('accepts the real, on-disk ci.yml', () => {
    const raw = readFileSync(CI_WORKFLOW_PATH, 'utf8');
    const workflow: unknown = parse(raw);
    expect(() =>
      assertApiReportCheckRuns(
        workflow as Parameters<typeof assertApiReportCheckRuns>[0],
      ),
    ).not.toThrow();
  });
});

/**
 * Regression tests for a race discovered while building this gate (issue
 * #285): `nx run-many --target=check:api-report` (the default, no
 * `--parallel` override) scheduled `@agentmonitors/core`'s `build` target
 * (pulled in transitively by every plugin's `^build` dependency) concurrently
 * with `@agentmonitors/core`'s own `check:api-report` target — two
 * independent processes racing to write `libs/core/dist/*` — and failed with
 * a transient `ENOENT: no such file or directory, unlink
 * '.../dist/index.d.ts.map'`. Reproduced 1-in-a-few-runs locally; fixed by
 * adding `--parallel=1` to both `nx run-many` invocations.
 */
describe('assertApiReportRunManyIsSerial', () => {
  it('rejects the pre-fix shape: nx run-many with no --parallel override', () => {
    expect(() =>
      assertApiReportRunManyIsSerial({
        scripts: {
          'check:api-report':
            'NX_TUI=false nx run-many --target=check:api-report --exclude=agentmonitors-workspace',
          'fix:api-report':
            'NX_TUI=false nx run-many --target=fix:api-report --exclude=agentmonitors-workspace',
        },
      }),
    ).toThrow(/"check:api-report", "fix:api-report"/);
  });

  it('rejects a --parallel value greater than 1 (still races)', () => {
    expect(() =>
      assertApiReportRunManyIsSerial({
        scripts: {
          'check:api-report':
            'nx run-many --target=check:api-report --parallel=3',
          'fix:api-report': 'nx run-many --target=fix:api-report --parallel=1',
        },
      }),
    ).toThrow(/"check:api-report"/);
  });

  // Regression guard: the pre-fix regex matched a bare `--parallel=1`
  // ANYWHERE in the script string, so an unrelated command chained into the
  // same line — one that never even touches `--target=check:api-report` —
  // could satisfy the guard while the actual `check:api-report` invocation
  // stayed unserialized.
  it('rejects --parallel=1 on an unrelated chained command, not the guarded invocation', () => {
    expect(() =>
      assertApiReportRunManyIsSerial({
        scripts: {
          'check:api-report':
            'nx run-many --target=check:api-report --exclude=x && nx run-many --target=irrelevant --parallel=1',
          'fix:api-report': 'nx run-many --target=fix:api-report --parallel=1',
        },
      }),
    ).toThrow(/"check:api-report"/);
  });

  it('accepts --parallel=1 on the guarded invocation even alongside an unrelated chained command', () => {
    expect(() =>
      assertApiReportRunManyIsSerial({
        scripts: {
          'check:api-report':
            'nx run-many --target=check:api-report --parallel=1 && nx run-many --target=irrelevant',
          'fix:api-report': 'nx run-many --target=fix:api-report --parallel=1',
        },
      }),
    ).not.toThrow();
  });

  it('rejects a script that never invokes --target=<name> at all', () => {
    expect(() =>
      assertApiReportRunManyIsSerial({
        scripts: {
          'check:api-report': 'echo "not an nx invocation"',
          'fix:api-report': 'nx run-many --target=fix:api-report --parallel=1',
        },
      }),
    ).toThrow(/"check:api-report"/);
  });

  it('accepts either `--parallel=1` or `--parallel 1` spelling (positive control)', () => {
    expect(() =>
      assertApiReportRunManyIsSerial({
        scripts: {
          'check:api-report':
            'nx run-many --target=check:api-report --parallel=1',
          'fix:api-report': 'nx run-many --target=fix:api-report --parallel 1',
        },
      }),
    ).not.toThrow();
  });

  // The real proof: the actual, on-disk root package.json.
  it('accepts the real, on-disk package.json', () => {
    const pkg: unknown = JSON.parse(
      readFileSync(ROOT_PACKAGE_JSON_PATH, 'utf8'),
    );
    expect(() =>
      assertApiReportRunManyIsSerial(
        pkg as Parameters<typeof assertApiReportRunManyIsSerial>[0],
      ),
    ).not.toThrow();
  });

  it('exercises both tracked scripts (sanity on the fixture list itself)', () => {
    expect(API_REPORT_RUN_MANY_SCRIPTS).toEqual([
      'check:api-report',
      'fix:api-report',
    ]);
  });
});

/**
 * Regression guard for issue #285's actual root cause, not just the CI-side
 * symptom the rest of this file covers: a single shared api-extractor
 * config let `build`'s `--local` rollup step silently rewrite the
 * checked-in api-report before `check:api-report`'s non-local validation
 * ever read it. The fix split every published package's config in two
 * (`api-extractor.build.json` / `api-extractor.report.json`); nothing else
 * in CI would fail if one package's `package.json` scripts quietly drifted
 * back to sharing a config or regained a stray `--local`, so this is the
 * forward pin.
 */
describe('assertApiReportScriptConfigSplit', () => {
  it('rejects "check:api-report" passing --local (would silently rewrite the checked-in report)', () => {
    expect(() =>
      assertApiReportScriptConfigSplit(
        {
          scripts: {
            'check:api-report':
              'tsup && tsc -p tsconfig.build.json && api-extractor run --local --verbose -c api-extractor.report.json',
            'fix:api-report':
              'tsup && tsc -p tsconfig.build.json && api-extractor run --local --verbose -c api-extractor.report.json',
            build:
              'tsup && tsc -p tsconfig.build.json && api-extractor run --local --verbose -c api-extractor.build.json',
          },
        },
        'test-package',
      ),
    ).toThrow(/"check:api-report" script must not pass --local/);
  });

  it('rejects "check:api-report" not referencing api-extractor.report.json', () => {
    expect(() =>
      assertApiReportScriptConfigSplit(
        {
          scripts: {
            'check:api-report':
              'tsup && tsc -p tsconfig.build.json && api-extractor run --verbose -c api-extractor.build.json',
            'fix:api-report':
              'tsup && tsc -p tsconfig.build.json && api-extractor run --local --verbose -c api-extractor.report.json',
            build:
              'tsup && tsc -p tsconfig.build.json && api-extractor run --local --verbose -c api-extractor.build.json',
          },
        },
        'test-package',
      ),
    ).toThrow(/"check:api-report" script must invoke api-extractor/);
  });

  it('rejects "fix:api-report" missing --local (would only validate, never regenerate)', () => {
    expect(() =>
      assertApiReportScriptConfigSplit(
        {
          scripts: {
            'check:api-report':
              'tsup && tsc -p tsconfig.build.json && api-extractor run --verbose -c api-extractor.report.json',
            'fix:api-report':
              'tsup && tsc -p tsconfig.build.json && api-extractor run --verbose -c api-extractor.report.json',
            build:
              'tsup && tsc -p tsconfig.build.json && api-extractor run --local --verbose -c api-extractor.build.json',
          },
        },
        'test-package',
      ),
    ).toThrow(/"fix:api-report" script must pass --local/);
  });

  it('rejects "build" referencing api-extractor.report.json instead of api-extractor.build.json', () => {
    expect(() =>
      assertApiReportScriptConfigSplit(
        {
          scripts: {
            'check:api-report':
              'tsup && tsc -p tsconfig.build.json && api-extractor run --verbose -c api-extractor.report.json',
            'fix:api-report':
              'tsup && tsc -p tsconfig.build.json && api-extractor run --local --verbose -c api-extractor.report.json',
            build:
              'tsup && tsc -p tsconfig.build.json && api-extractor run --local --verbose -c api-extractor.report.json',
          },
        },
        'test-package',
      ),
    ).toThrow(/"build" script must invoke api-extractor/);
  });

  it('accepts a correctly split shape (positive control)', () => {
    expect(() =>
      assertApiReportScriptConfigSplit(
        {
          scripts: {
            'check:api-report':
              'tsup && tsc -p tsconfig.build.json && api-extractor run --verbose -c api-extractor.report.json',
            'fix:api-report':
              'tsup && tsc -p tsconfig.build.json && api-extractor run --local --verbose -c api-extractor.report.json',
            build:
              'tsup && tsc -p tsconfig.build.json && api-extractor run --local --verbose -c api-extractor.build.json',
          },
        },
        'test-package',
      ),
    ).not.toThrow();
  });

  // The real proof: every actual, on-disk publishable package (from
  // `PACKAGE_DIRS`, the single source of truth used by the publisher and
  // the standalone-consumer smoke test) that has its own api-extractor
  // configs must satisfy the split. If any future package's scripts drift
  // back to a shared config or a stray `--local`, this fails — closing the
  // exact gap #285 shipped without: nothing else in CI pins this per
  // package.
  it.each(PACKAGE_DIRS.filter(hasApiExtractorConfigs))(
    'accepts the real, on-disk package.json for %s',
    (packageDir) => {
      const pkg: unknown = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf8'),
      );
      expect(() =>
        assertApiReportScriptConfigSplit(
          pkg as Parameters<typeof assertApiReportScriptConfigSplit>[0],
          packageDir,
        ),
      ).not.toThrow();
    },
  );

  // Sanity check on the fixture selection itself: at least one real package
  // must actually have api-extractor configs, or the `it.each` above would
  // silently run zero cases and this whole describe block would give false
  // confidence.
  it('finds at least one package with api-extractor configs (sanity on PACKAGE_DIRS filtering)', () => {
    expect(PACKAGE_DIRS.filter(hasApiExtractorConfigs).length).toBeGreaterThan(
      0,
    );
  });
});
