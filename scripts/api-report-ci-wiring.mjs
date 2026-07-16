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

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repo root, derived the same way as every other path this module exports. */
export const REPO_ROOT = join(scriptDir, '..');

/** Absolute path to the real, on-disk CI workflow this module guards. */
export const CI_WORKFLOW_PATH = join(
  scriptDir,
  '..',
  '.github',
  'workflows',
  'ci.yml',
);

/** Absolute path to the real, on-disk root `package.json` this module guards. */
export const ROOT_PACKAGE_JSON_PATH = join(scriptDir, '..', 'package.json');

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
 * @typedef {{ run?: string; uses?: string; name?: string; if?: unknown; 'continue-on-error'?: unknown }} WorkflowStep
 * @typedef {{ if?: unknown; steps?: WorkflowStep[] }} WorkflowJob
 * @typedef {{ jobs?: Record<string, WorkflowJob> }} CiWorkflow
 */

/**
 * Find every step in a job whose `run:` command matches `pattern`. Used so
 * the gate can inspect the matching step object itself (its `if:` and
 * `continue-on-error:` keys), not just whether the command text appears
 * somewhere in the job.
 *
 * @param {WorkflowJob | undefined} job
 * @param {RegExp} pattern
 * @returns {WorkflowStep[]}
 */
function stepsMatching(job, pattern) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return steps.filter(
    (step) => typeof step.run === 'string' && pattern.test(step.run),
  );
}

/**
 * Root npm scripts that fan an api-report target out across every published
 * package via `nx run-many`. Both MUST run serially — see
 * `assertApiReportRunManyIsSerial` for why.
 */
export const API_REPORT_RUN_MANY_SCRIPTS = [
  'check:api-report',
  'fix:api-report',
];

/**
 * @typedef {{ scripts?: Record<string, string> }} RootPackageJson
 */

/**
 * Split a shell script string into its individual chained commands (on
 * `&&`, `||`, `;`, or a newline). Used so `--parallel=1` can be verified as
 * part of the SAME `nx run-many --target=...` invocation it's meant to
 * guard, rather than matching anywhere in the whole script string — a bare
 * `/--parallel(?:=|\s+)1\b/.test(script)` over the entire script would be
 * satisfied by an unrelated `--parallel=1` on a totally different command
 * chained into the same line, without the actual `--target=check:api-report`
 * (or `fix:api-report`) invocation being serialized at all.
 *
 * @param {string} script
 * @returns {string[]}
 */
function splitChainedCommands(script) {
  return script.split(/&&|\|\||;|\n/);
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate that the root `check:api-report`/`fix:api-report` npm scripts
 * invoke `nx run-many --target=<name>` with `--parallel=1` on that SAME
 * invocation (not merely present somewhere else in the script string).
 *
 * These scripts fan an api-report target out across every published package.
 * Each package's `check:api-report`/`fix:api-report` script independently
 * re-emits its own declarations (`tsup && tsc -p tsconfig.build.json`) before
 * invoking API Extractor — and `@agentmonitors/core`'s `build` target (which
 * every plugin's `^build` dependency pulls in, since a plugin's
 * declarations import core's `dist/rollup.d.ts`) writes into that same
 * project's `dist/` folder. Without `--parallel=1`, nx schedules
 * `core:build` (needed transitively for the plugins) concurrently with
 * `core:check:api-report` (requested directly) — two independent processes
 * racing to write `libs/core/dist/*`, observed as a transient `ENOENT:
 * no such file or directory, unlink '.../dist/index.d.ts.map'` (issue #285).
 *
 * @param {RootPackageJson} pkg
 */
export function assertApiReportRunManyIsSerial(pkg) {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') {
    throw new Error('package.json has no top-level "scripts" section');
  }

  const problems = API_REPORT_RUN_MANY_SCRIPTS.filter((name) => {
    const script = scripts[name];
    if (typeof script !== 'string') {
      return true;
    }
    const targetPattern = new RegExp(`--target=${escapeRegExp(name)}(?:\\s|$)`);
    const invocations = splitChainedCommands(script).filter((command) =>
      targetPattern.test(command),
    );
    if (invocations.length === 0) {
      // The script never even invokes `nx run-many --target=<name>` — a
      // different, more specific failure than a missing `--parallel=1`,
      // but still a reason to reject this script.
      return true;
    }
    return !invocations.every((command) =>
      /--parallel(?:=|\s+)1\b/.test(command),
    );
  });
  if (problems.length > 0) {
    throw new Error(
      `package.json script(s) ${problems.map((n) => `"${n}"`).join(', ')} ` +
        'must invoke `nx run-many --target=<name>` with `--parallel=1` on ' +
        "that same invocation — without it, a package's own api-report " +
        "check races that same package's `build` target when a sibling " +
        'package pulls it in via `^build` (issue #285)',
    );
  }
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

  // Reject the mere PRESENCE of an `if` key, not just a non-empty string
  // value. YAML `if: false` / `if: 0` parse as a boolean/number rather than
  // a string — a `typeof job.if === 'string'` guard would silently let
  // those through, even though both are GitHub-Actions-falsy and would make
  // this job (and the API report check with it) never run at all.
  if ('if' in job) {
    throw new Error(
      `ci.yml "${REQUIRED_JOB_ID}" job must run unconditionally (no "if:" ` +
        'key at all), so the API report check can never be skipped by any ' +
        'condition (issue #285)',
    );
  }

  // `(?:\s|$)` (not `\b`): a word boundary also matches before `:`, so
  // `check:api-report:something` would satisfy a `\b` guard without ever
  // running the real `check:api-report` script (see #353 for the same class
  // of gap in the website deploy-workflow guard).
  const pattern = /pnpm(?:\s+run)?\s+check:api-report(?:\s|$)/m;
  const matchingSteps = stepsMatching(job, pattern);
  if (matchingSteps.length === 0) {
    throw new Error(
      `ci.yml "${REQUIRED_JOB_ID}" job never runs \`pnpm check:api-report\` — ` +
        'the checked-in API reports (api-report/*.api.md) can drift from the ' +
        'real compiled surface without failing CI (issue #285)',
    );
  }

  // Reject the mere PRESENCE of a step-level `if` or `continue-on-error` key
  // on the step that runs `check:api-report` — same rigor as the job-level
  // `if` check above. The job itself can be unconditional while a
  // step-level `if:` (e.g. gated on `github.event_name == 'push'`, which
  // never fires for a pull request) silently skips just this step, or a
  // `continue-on-error: true` lets the step fail without failing the job —
  // either way the gate would stay green while API report drift goes
  // undetected.
  for (const step of matchingSteps) {
    if ('if' in step) {
      throw new Error(
        `ci.yml "${REQUIRED_JOB_ID}" job's \`pnpm check:api-report\` step ` +
          'must run unconditionally (no step-level "if:" key), so the API ' +
          'report check can never be skipped by any condition (issue #285)',
      );
    }
    if ('continue-on-error' in step) {
      throw new Error(
        `ci.yml "${REQUIRED_JOB_ID}" job's \`pnpm check:api-report\` step ` +
          'must not set "continue-on-error" — a failing API report check ' +
          'must fail the build, not be silently swallowed (issue #285)',
      );
    }
  }
}

/**
 * A package directory (relative to `REPO_ROOT`) qualifies for
 * `assertApiReportScriptConfigSplit` when it has its own
 * `api-extractor.build.json`/`api-extractor.report.json` pair — i.e. it is a
 * published TypeScript package with a curated public API, not every entry in
 * `PACKAGE_DIRS` (e.g. `apps/cli` builds with plain `tsup`, no api-extractor
 * rollup at all).
 *
 * @param {string} packageDir - relative to `REPO_ROOT` (e.g. "libs/core")
 * @returns {boolean}
 */
export function hasApiExtractorConfigs(packageDir) {
  return (
    existsSync(join(REPO_ROOT, packageDir, 'api-extractor.build.json')) &&
    existsSync(join(REPO_ROOT, packageDir, 'api-extractor.report.json'))
  );
}

/**
 * Validate that a single package's `check:api-report`/`fix:api-report`/
 * `build` npm scripts route to the correct, non-shared api-extractor
 * config and `--local` flag. This is the actual root cause of issue #285:
 * a single shared api-extractor config let `build`'s `--local` rollup step
 * (scheduled as a dependency of a sibling package's `check:api-report` via
 * `^build`) silently rewrite the checked-in report before the non-local
 * `check:api-report` validation ever read it. The fix split the config in
 * two (`api-extractor.build.json`, apiReport disabled;
 * `api-extractor.report.json`, apiReport enabled) — this guard is the
 * forward-pin that keeps that split from regressing per-package, since
 * nothing else in CI would fail if one package's scripts quietly drifted
 * back to sharing a config.
 *
 * @param {{ scripts?: Record<string, string> }} pkg
 * @param {string} label - identifies the package in thrown errors (e.g. its package.json path)
 */
export function assertApiReportScriptConfigSplit(pkg, label) {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') {
    throw new Error(`${label} has no top-level "scripts" section`);
  }

  const checkScript = scripts['check:api-report'];
  if (typeof checkScript !== 'string') {
    throw new Error(`${label} is missing a "check:api-report" script`);
  }
  if (/--local\b/.test(checkScript)) {
    throw new Error(
      `${label} "check:api-report" script must not pass --local — it must ` +
        'fail on api-report drift instead of silently rewriting the ' +
        'checked-in report before CI ever validates it (issue #285)',
    );
  }
  if (!checkScript.includes('api-extractor.report.json')) {
    throw new Error(
      `${label} "check:api-report" script must invoke api-extractor with ` +
        '"-c api-extractor.report.json" (issue #285)',
    );
  }

  const fixScript = scripts['fix:api-report'];
  if (typeof fixScript !== 'string') {
    throw new Error(`${label} is missing a "fix:api-report" script`);
  }
  if (!/--local\b/.test(fixScript)) {
    throw new Error(
      `${label} "fix:api-report" script must pass --local, so it ` +
        'regenerates the checked-in report locally instead of only ' +
        'validating it (issue #285)',
    );
  }
  if (!fixScript.includes('api-extractor.report.json')) {
    throw new Error(
      `${label} "fix:api-report" script must invoke api-extractor with ` +
        '"-c api-extractor.report.json" (issue #285)',
    );
  }

  const buildScript = scripts.build;
  if (typeof buildScript !== 'string') {
    throw new Error(`${label} is missing a "build" script`);
  }
  if (!buildScript.includes('api-extractor.build.json')) {
    throw new Error(
      `${label} "build" script must invoke api-extractor with ` +
        '"-c api-extractor.build.json" — not the report config, so its ' +
        '--local rollup step can never rewrite the checked-in api-report ' +
        '(issue #285)',
    );
  }
}
