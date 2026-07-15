// Parses `.github/workflows/ci.yml` and validates that the root
// `check:api-report` npm script is actually invoked by an unconditional CI
// step. See issue #285: before this module existed, `package.json` defined
// `check:api-report`, but nothing in CI ever ran it — `pnpm check` and CI
// only ran `check`/`test`/`test:serial`/`test:scripts`, so a checked-in API
// report could drift from the real compiled surface indefinitely without
// ever failing a build. This guard fails if that "defined but unused" gap
// reopens (the script is removed from the job, moved to a job gated behind a
// path filter that can skip it, or renamed without updating the workflow).
//
// Uses the `yaml` package (not `js-yaml`) deliberately: `js-yaml`'s default
// YAML 1.1 schema parses the bare `on:` key as the boolean `true`, silently
// breaking any code that reads `workflow.on`. `yaml` defaults to the YAML 1.2
// core schema, where `on` stays a string key.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the real, on-disk CI workflow this module guards. */
export const CI_WORKFLOW_PATH = join(
  scriptDir,
  '..',
  '.github',
  'workflows',
  'ci.yml',
);

/**
 * The job in `ci.yml` that must run `check:api-report`. This must be the
 * always-runs "Check And Test" job (no `pull_request`-path filter, no
 * `if:` condition) — not one of the path-filtered jobs (e.g.
 * `release-collateral-changed`, `publish-dry-run`) that can legitimately
 * skip on a PR that doesn't touch publishable packages. A path-filtered job
 * would let an API-report-changing PR skip the check.
 */
export const REQUIRED_JOB_ID = 'test';

/**
 * @typedef {{ run?: string; uses?: string; name?: string }} WorkflowStep
 * @typedef {{ if?: string; steps?: WorkflowStep[] }} WorkflowJob
 * @typedef {{ jobs?: Record<string, WorkflowJob> }} CiWorkflow
 */

/**
 * Concatenate every `run:` line across a job's steps into one string, so
 * gate-detection can pattern-match without caring which step number a
 * particular command lives in.
 *
 * @param {WorkflowJob | undefined} job
 * @returns {string}
 */
function jobRunLines(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return steps
    .map((step) => (typeof step.run === 'string' ? step.run : ''))
    .join('\n');
}

/**
 * Validate that the root `check:api-report` npm script is invoked from the
 * unconditional `REQUIRED_JOB_ID` job. Throws a specific, named error
 * identifying exactly what is missing rather than a generic assertion
 * failure.
 *
 * @param {CiWorkflow} workflow
 */
export function assertApiReportCheckRuns(workflow) {
  const jobs = workflow.jobs;
  if (!jobs || typeof jobs !== 'object') {
    throw new Error('ci.yml has no top-level "jobs" section');
  }

  const job = jobs[REQUIRED_JOB_ID];
  if (!job) {
    throw new Error(`ci.yml is missing the "${REQUIRED_JOB_ID}" job`);
  }

  if (typeof job.if === 'string' && job.if.length > 0) {
    throw new Error(
      `ci.yml "${REQUIRED_JOB_ID}" job must run unconditionally (no "if:"), ` +
        'so the API report check can never be skipped by a path filter ' +
        '(issue #285)',
    );
  }

  // `(?:\s|$)` (not `\b`): a word boundary also matches before `:`, so
  // `check:api-report:something` would satisfy a `\b` guard without ever
  // running the real `check:api-report` script (see #353 for the same class
  // of gap in the website deploy-workflow guard).
  const pattern = /pnpm(?:\s+run)?\s+check:api-report(?:\s|$)/m;
  if (!pattern.test(jobRunLines(job))) {
    throw new Error(
      `ci.yml "${REQUIRED_JOB_ID}" job never runs \`pnpm check:api-report\` — ` +
        'the checked-in API reports (api-report/*.api.md) can drift from the ' +
        'real compiled surface without failing CI (issue #285)',
    );
  }
}
