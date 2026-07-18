// Parses `.github/workflows/deploy-website.yml` and validates the shape of
// its production gate. Three invariants:
//
//   1. Validation gates the deploy (issue #286): the website typecheck and
//      test suite run on the critical path, in the deploy pipeline, BEFORE the
//      `vercel deploy` step and against the exact commit being deployed.
//      Before this gate existed, only the website `check` ran, so a website
//      test regression (e.g. next.config.test.ts, which guards
//      deployment-specific tracing behavior) could reach production
//      undetected.
//
//   2. The deploy is a REMOTE Vercel build (`vercel deploy --prod`), NOT a
//      prebuilt-artifact promotion. `vercel build` in this pnpm workspace
//      traces dependencies through workspace symlinks into the repo-root
//      .pnpm store, so the Build Output API's per-function filePathMap
//      references files OUTSIDE `.vercel/output` (../../node_modules/.pnpm/…).
//      That output is not portable: deploying it fails with "Please ensure
//      project dependencies have been installed" without the installed
//      workspace on disk, and WITH it the references escape the deploy root
//      and fail Vercel-side with ENOENT on /node_modules/…. The `site`
//      project builds apps/website standalone (root directory = the app), a
//      context a local workspace build cannot reproduce. `vercel deploy
//      --prebuilt` — and the two-job upload/download-artifact promotion that
//      fed it — broke EVERY production deploy between PR #353 and this fix, so
//      this guard fails if either is reintroduced.
//
//   3. The `push.paths` trigger includes the root/shared inputs that can
//      change the resolved site (the lockfile, the workspace file, root
//      package.json) even though they live outside `apps/website/**`.
//
// Uses the `yaml` package (not `js-yaml`) deliberately: `js-yaml`'s default
// YAML 1.1 schema parses the bare `on:` key as the boolean `true`, silently
// breaking any code that reads `workflow.on`. `yaml` defaults to the YAML 1.2
// core schema, where `on` stays a string key.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the real, on-disk deploy workflow this module guards. */
export const DEPLOY_WORKFLOW_PATH = join(
  scriptDir,
  '..',
  '.github',
  'workflows',
  'deploy-website.yml',
);

/**
 * @typedef {{ run?: string; uses?: string; name?: string; with?: Record<string, unknown> }} WorkflowStep
 * @typedef {{ needs?: string | string[]; steps?: WorkflowStep[] }} WorkflowJob
 * @typedef {{
 *   on?: { push?: { paths?: string[] } };
 *   jobs?: Record<string, WorkflowJob>;
 * }} DeployWorkflow
 */

/**
 * A step's `run:` text, or the empty string if it has none.
 *
 * @param {WorkflowStep | undefined} step
 * @returns {string}
 */
function stepRun(step) {
  return typeof step?.run === 'string' ? step.run : '';
}

/**
 * Concatenate every `run:` line across a job's steps into one string.
 *
 * @param {WorkflowJob | undefined} job
 * @returns {string}
 */
function jobRunLines(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return steps.map(stepRun).join('\n');
}

/**
 * Find the job that performs the deploy (contains a `vercel deploy` step).
 *
 * @param {DeployWorkflow} workflow
 * @returns {WorkflowJob | undefined}
 */
function findDeployJob(workflow) {
  const jobs = workflow.jobs;
  if (!jobs || typeof jobs !== 'object') return undefined;
  return Object.values(jobs).find((job) =>
    /vercel deploy\b/.test(jobRunLines(job)),
  );
}

// `(?:\s|$)` (not `\b`): a word boundary also matches before `:`, so
// `check:lint` / `test:unit` would satisfy a `\b` guard without ever running
// the actual `check` / `test` scripts (review finding on #353).
const WEBSITE_TYPECHECK = /@agentmonitors\/website\s+check(?:\s|$)/m;
const WEBSITE_TEST = /@agentmonitors\/website\s+test(?:\s|$)/m;
const VERCEL_DEPLOY = /vercel deploy\b/;

/**
 * Validate that the website typecheck and test suite run BEFORE the deploy
 * step, in the deploy pipeline, so a regression is caught on the critical path
 * before anything reaches production (issue #286). This is expressed for the
 * single-job shape: the validation steps precede the `vercel deploy` step in
 * the same job. Throws a specific, named error identifying exactly which
 * guarantee is missing.
 *
 * @param {DeployWorkflow} workflow
 */
export function assertValidationGatesDeploy(workflow) {
  const jobs = workflow.jobs;
  if (!jobs || typeof jobs !== 'object') {
    throw new Error('deploy-website.yml has no top-level "jobs" section');
  }

  const deployJob = findDeployJob(workflow);
  if (!deployJob) {
    throw new Error(
      'deploy-website.yml has no job running `vercel deploy` — nothing deploys',
    );
  }

  const steps = Array.isArray(deployJob.steps) ? deployJob.steps : [];
  const typecheckIdx = steps.findIndex((s) =>
    WEBSITE_TYPECHECK.test(stepRun(s)),
  );
  const testIdx = steps.findIndex((s) => WEBSITE_TEST.test(stepRun(s)));
  const deployIdx = steps.findIndex((s) => VERCEL_DEPLOY.test(stepRun(s)));

  const missing = [];
  if (typecheckIdx === -1) missing.push('website typecheck');
  if (testIdx === -1) missing.push('website test suite');
  if (missing.length > 0) {
    throw new Error(
      'deploy pipeline is missing required validation step(s) before the ' +
        `deploy: ${missing.join(', ')} — without them a regression reaches ` +
        'production undetected (issue #286)',
    );
  }

  if (typecheckIdx > deployIdx || testIdx > deployIdx) {
    throw new Error(
      'website typecheck and test must run BEFORE the `vercel deploy` step so ' +
        'validation gates the deploy on the critical path (issue #286)',
    );
  }
}

/**
 * Every step across all jobs whose `uses:` starts with the given action
 * prefix.
 *
 * @param {DeployWorkflow} workflow
 * @param {string} actionPrefix
 * @returns {WorkflowStep[]}
 */
function actionSteps(workflow, actionPrefix) {
  const jobs = workflow.jobs ?? {};
  return Object.values(jobs)
    .flatMap((job) => (Array.isArray(job.steps) ? job.steps : []))
    .filter(
      (step) =>
        typeof step.uses === 'string' && step.uses.startsWith(actionPrefix),
    );
}

/**
 * Validate that the deploy is a remote Vercel build (`vercel deploy --prod`,
 * no `--prebuilt`), never a prebuilt-artifact promotion. See the module
 * header for why `vercel build` output is not portable in this pnpm
 * workspace. This is a regression guard: it fails if `vercel deploy
 * --prebuilt`, or the two-job `.vercel/output` upload/download-artifact
 * promotion that fed it, is reintroduced.
 *
 * @param {DeployWorkflow} workflow
 */
export function assertDeployUsesRemoteBuild(workflow) {
  const allRun = Object.values(workflow.jobs ?? {})
    .map(jobRunLines)
    .join('\n');

  if (
    /vercel deploy\b[^\n]*--prebuilt\b|--prebuilt\b[^\n]*vercel deploy\b/.test(
      allRun,
    )
  ) {
    throw new Error(
      '`vercel deploy --prebuilt` is incompatible with this pnpm monorepo: ' +
        "`vercel build`'s output references dependency files outside " +
        '.vercel/output (../../node_modules/.pnpm/…), so the prebuilt ' +
        'artifact is not portable and the deploy fails. Use a remote build ' +
        '(`vercel deploy --prod`) instead.',
    );
  }

  if (
    !/vercel deploy\b[^\n]*--prod\b|--prod\b[^\n]*vercel deploy\b/.test(allRun)
  ) {
    throw new Error(
      'deploy-website.yml must run `vercel deploy --prod` (a remote ' +
        'production build) — no production deploy command was found',
    );
  }

  // The prebuilt-promotion artifact round-trip must not return either: an
  // upload or download of `.vercel/output` exists only to feed `--prebuilt`.
  for (const [prefix, verb] of [
    ['actions/upload-artifact@', 'uploads'],
    ['actions/download-artifact@', 'downloads'],
  ]) {
    const offending = actionSteps(workflow, prefix).find((step) =>
      /\.vercel\/output/.test(String(step.with?.path ?? '')),
    );
    if (offending) {
      throw new Error(
        `deploy-website.yml ${verb} the Vercel build output (.vercel/output) ` +
          'as a workflow artifact — that is the prebuilt-promotion flow, ' +
          'which is incompatible with this pnpm monorepo. Deploy with a ' +
          'remote build instead.',
      );
    }
  }
}

/** Root/shared inputs that can change the resolved website build even though
 * they live outside `apps/website/**` — see the comment in
 * deploy-website.yml for why each one matters. */
export const REQUIRED_SHARED_PATH_TRIGGERS = [
  'apps/website/**',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
];

/**
 * Validate that the `push.paths` trigger includes both the website directory
 * and the root/shared inputs that can change the resolved site.
 *
 * @param {DeployWorkflow} workflow
 */
export function assertPathTriggersIncludeSharedInputs(workflow) {
  const paths = workflow.on?.push?.paths;
  if (!Array.isArray(paths)) {
    throw new Error('deploy-website.yml push trigger has no "paths" filter');
  }

  const missing = REQUIRED_SHARED_PATH_TRIGGERS.filter(
    (required) => !paths.includes(required),
  );
  if (missing.length > 0) {
    throw new Error(
      `deploy-website.yml push "paths" filter is missing: ${missing.join(', ')}`,
    );
  }
}
