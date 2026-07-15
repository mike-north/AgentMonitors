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
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CI_WORKFLOW_PATH,
  REQUIRED_JOB_ID,
  assertApiReportCheckRuns,
} from './api-report-ci-wiring.mjs';

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
