// Parses `.github/workflows/deploy-website.yml` and validates the shape of
// its production gate: the `deploy` job must `needs: validate`, `validate`
// must run the website's typecheck, its own test suite, and a production
// build (all against the exact commit before `deploy` is allowed to start),
// and the `push.paths` trigger must include the root/shared inputs that can
// change the resolved site (the lockfile, the workspace file, root
// package.json). See issue #286: before this module existed, `validate` only
// ran the website's `check` script, so a website test or build regression
// (e.g. `next.config.test.ts`, which guards deployment-specific tracing
// behavior) could land in production undetected, and a `pnpm-lock.yaml`
// change that altered the site's resolved dependencies never re-triggered
// deploy validation at all.
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
 * Validate that `deploy` cannot start before `validate` passes, and that
 * `validate` actually runs the website's typecheck, test, and production
 * build (not just typecheck, which was the pre-#286 shape). Throws a
 * specific, named error identifying exactly which gate is missing rather
 * than a generic assertion failure.
 *
 * @param {DeployWorkflow} workflow
 */
export function assertValidateGatesDeploy(workflow) {
  const jobs = workflow.jobs;
  if (!jobs || typeof jobs !== 'object') {
    throw new Error('deploy-website.yml has no top-level "jobs" section');
  }

  const validate = jobs.validate;
  const deploy = jobs.deploy;
  if (!validate) {
    throw new Error('deploy-website.yml is missing a "validate" job');
  }
  if (!deploy) {
    throw new Error('deploy-website.yml is missing a "deploy" job');
  }

  const needs = Array.isArray(deploy.needs)
    ? deploy.needs
    : deploy.needs !== undefined
      ? [deploy.needs]
      : [];
  if (!needs.includes('validate')) {
    throw new Error(
      'deploy job must `needs: validate` — without it, a broken commit can ' +
        'reach production before validation finishes (issue #286)',
    );
  }

  const runLines = jobRunLines(validate);
  /** @type {Array<{ name: string; pattern: RegExp }>} */
  const requiredGates = [
    {
      // `(?:\s|$)` (not `\b`): a word boundary also matches before `:`, so
      // `check:lint` / `test:unit` would satisfy a `\b` guard without ever
      // running the actual `check` / `test` scripts.
      name: 'website typecheck',
      pattern: /@agentmonitors\/website\s+check(?:\s|$)/m,
    },
    {
      name: 'website test suite',
      pattern: /@agentmonitors\/website\s+test(?:\s|$)/m,
    },
    {
      name: 'production build of the exact commit',
      pattern: /vercel build\b[^\n]*--prod\b|--prod\b[^\n]*vercel build\b/,
    },
  ];

  const missing = requiredGates.filter((gate) => !gate.pattern.test(runLines));
  if (missing.length > 0) {
    throw new Error(
      'validate job is missing required gate step(s): ' +
        missing.map((gate) => gate.name).join(', '),
    );
  }
}

/**
 * Find a job's first step whose `uses:` starts with the given action prefix.
 *
 * @param {WorkflowJob | undefined} job
 * @param {string} actionPrefix
 * @returns {WorkflowStep | undefined}
 */
function findActionStep(job, actionPrefix) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return steps.find(
    (step) =>
      typeof step.uses === 'string' && step.uses.startsWith(actionPrefix),
  );
}

/**
 * Validate that `deploy` promotes the exact artifact `validate` already
 * built and validated, rather than triggering a second, independent remote
 * build against the same commit: `validate` must upload a build artifact,
 * `deploy` must download that same artifact (same `name`, same `path` — a
 * download of some unrelated artifact, or to the wrong directory, would
 * false-pass an existence-only check while `vercel deploy --prebuilt`
 * silently deploys nothing), and deploy it with `vercel deploy --prebuilt`.
 *
 * @param {DeployWorkflow} workflow
 */
export function assertDeployPromotesArtifact(workflow) {
  const deploy = workflow.jobs?.deploy;
  if (!deploy) {
    throw new Error('deploy-website.yml is missing a "deploy" job');
  }

  const upload = findActionStep(
    workflow.jobs?.validate,
    'actions/upload-artifact@',
  );
  if (!upload) {
    throw new Error(
      'validate job must upload the production build artifact ' +
        '(actions/upload-artifact) so deploy can promote the exact ' +
        'validated build (issue #286)',
    );
  }

  const download = findActionStep(deploy, 'actions/download-artifact@');
  if (!download) {
    throw new Error(
      'deploy job must download the build artifact validate uploaded ' +
        '(actions/download-artifact) to deploy the exact validated build, ' +
        'not rebuild from source (issue #286)',
    );
  }

  for (const key of ['name', 'path']) {
    const uploaded = upload.with?.[key];
    const downloaded = download.with?.[key];
    if (
      typeof uploaded !== 'string' ||
      uploaded.length === 0 ||
      uploaded !== downloaded
    ) {
      throw new Error(
        `deploy must download the same artifact validate uploaded, but the ` +
          `"${key}" differs (upload: ${JSON.stringify(uploaded)}, download: ` +
          `${JSON.stringify(downloaded)}) — a mismatched ${key} deploys ` +
          'something other than the validated build (issue #286)',
      );
    }
  }

  const runLines = jobRunLines(deploy);
  if (
    !/vercel deploy\b[^\n]*--prebuilt\b|--prebuilt\b[^\n]*vercel deploy\b/.test(
      runLines,
    )
  ) {
    throw new Error(
      'deploy job must run `vercel deploy --prebuilt` to promote the ' +
        'artifact validate already built, not trigger a second remote ' +
        'build of the same commit (issue #286)',
    );
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
