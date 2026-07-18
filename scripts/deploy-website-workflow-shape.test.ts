/**
 * Tests for the production-deploy workflow-shape guard
 * (`.github/workflows/deploy-website.yml`). Three invariants, each proved
 * against the *real* on-disk workflow parsed with the `yaml` package — the
 * same GitHub-Actions-YAML input contract CI itself consumes — plus
 * negative-proof fixtures showing each guard rejects the shape it exists to
 * catch:
 *
 *   1. Validation gates the deploy (issue #286): the website typecheck and
 *      test run before the `vercel deploy` step, on the critical path.
 *   2. The deploy is a remote Vercel build, never a `--prebuilt` promotion —
 *      `vercel build` output is not portable in this pnpm workspace (its
 *      per-function filePathMap references ../../node_modules/.pnpm/… outside
 *      .vercel/output), which broke every production deploy between PR #353
 *      and this fix.
 *   3. The push `paths` filter includes the root/shared inputs (lockfile,
 *      workspace file, root package.json) that can change the resolved site.
 *
 * @see https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions
 * @see https://eemeli.org/yaml/ (YAML 1.2 core schema: `on:` stays a string key)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  DEPLOY_WORKFLOW_PATH,
  REQUIRED_SHARED_PATH_TRIGGERS,
  assertDeployUsesRemoteBuild,
  assertPathTriggersIncludeSharedInputs,
  assertValidationGatesDeploy,
} from './deploy-website-workflow-shape.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** Parse a workflow fixture into the loosely-typed shape the guards accept. */
function workflow(
  yaml: string,
): Parameters<typeof assertValidationGatesDeploy>[0] {
  return parse(yaml) as Parameters<typeof assertValidationGatesDeploy>[0];
}

/** The real, on-disk workflow, parsed exactly as CI would parse it. */
function onDiskWorkflow(): Parameters<typeof assertValidationGatesDeploy>[0] {
  return workflow(readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8'));
}

// A well-formed single-job deploy pipeline: install → typecheck → test →
// deploy (remote build). The positive control the guards must accept.
const GOOD_PIPELINE = `
on:
  push:
    paths:
      - 'apps/website/**'
      - 'pnpm-lock.yaml'
      - 'pnpm-workspace.yaml'
      - 'package.json'
jobs:
  deploy:
    steps:
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @agentmonitors/website check
      - run: pnpm --filter @agentmonitors/website test
      - run: vercel deploy --prod --yes --cwd apps/website
`;

describe('assertValidationGatesDeploy', () => {
  it('rejects a deploy step that runs before the typecheck and test', () => {
    expect(() =>
      assertValidationGatesDeploy(
        workflow(`
jobs:
  deploy:
    steps:
      - run: vercel deploy --prod --yes --cwd apps/website
      - run: pnpm --filter @agentmonitors/website check
      - run: pnpm --filter @agentmonitors/website test
`),
      ),
    ).toThrow(/BEFORE the .*vercel deploy.* step/);
  });

  it('rejects a deploy pipeline missing the test step', () => {
    expect(() =>
      assertValidationGatesDeploy(
        workflow(`
jobs:
  deploy:
    steps:
      - run: pnpm --filter @agentmonitors/website check
      - run: vercel deploy --prod --yes --cwd apps/website
`),
      ),
    ).toThrow(/website test suite/);
  });

  it('rejects a pipeline with no `vercel deploy` step at all', () => {
    expect(() =>
      assertValidationGatesDeploy(
        workflow(`
jobs:
  deploy:
    steps:
      - run: pnpm --filter @agentmonitors/website check
      - run: pnpm --filter @agentmonitors/website test
`),
      ),
    ).toThrow(/no job running .*vercel deploy/);
  });

  // Regression test for the review finding on #353: `\b` after the script
  // name also matches before `:`, so `check:lint` / `test:unit` lookalikes
  // must NOT satisfy the guard in place of the real `check` / `test` scripts.
  it('rejects check:lint / test:unit lookalikes standing in for the real scripts', () => {
    expect(() =>
      assertValidationGatesDeploy(
        workflow(`
jobs:
  deploy:
    steps:
      - run: pnpm --filter @agentmonitors/website check:lint
      - run: pnpm --filter @agentmonitors/website test:unit
      - run: vercel deploy --prod --yes --cwd apps/website
`),
      ),
    ).toThrow(/website typecheck.*website test suite/s);
  });

  it('accepts a well-formed single-job pipeline (positive control)', () => {
    expect(() =>
      assertValidationGatesDeploy(workflow(GOOD_PIPELINE)),
    ).not.toThrow();
  });

  // The real proof: the actual, on-disk workflow — parsed exactly as CI
  // would parse it — must satisfy the gate. If a future edit reorders the
  // deploy ahead of validation, or drops the typecheck/test steps, this fails.
  it('accepts the real, on-disk deploy-website.yml', () => {
    expect(() => assertValidationGatesDeploy(onDiskWorkflow())).not.toThrow();
  });
});

describe('assertDeployUsesRemoteBuild', () => {
  it('rejects `vercel deploy --prebuilt` (prebuilt output is not portable here)', () => {
    expect(() =>
      assertDeployUsesRemoteBuild(
        workflow(`
jobs:
  deploy:
    steps:
      - run: vercel build --prod --yes --cwd apps/website
      - run: vercel deploy --prebuilt --prod --yes --cwd apps/website
`),
      ),
    ).toThrow(/--prebuilt.* is incompatible/);
  });

  it('rejects reintroducing the two-job .vercel/output upload promotion', () => {
    expect(() =>
      assertDeployUsesRemoteBuild(
        workflow(`
jobs:
  validate:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: website-vercel-build
          path: apps/website/.vercel/output
  deploy:
    steps:
      - run: vercel deploy --prod --yes --cwd apps/website
`),
      ),
    ).toThrow(/uploads the Vercel build output/);
  });

  it('rejects reintroducing the .vercel/output download promotion', () => {
    expect(() =>
      assertDeployUsesRemoteBuild(
        workflow(`
jobs:
  deploy:
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: website-vercel-build
          path: apps/website/.vercel/output
      - run: vercel deploy --prod --yes --cwd apps/website
`),
      ),
    ).toThrow(/downloads the Vercel build output/);
  });

  it('rejects a pipeline with no `vercel deploy --prod` step', () => {
    expect(() =>
      assertDeployUsesRemoteBuild(
        workflow(`
jobs:
  deploy:
    steps:
      - run: pnpm --filter @agentmonitors/website check
`),
      ),
    ).toThrow(/must run .*vercel deploy --prod/);
  });

  it('accepts a remote-build deploy (positive control)', () => {
    expect(() =>
      assertDeployUsesRemoteBuild(workflow(GOOD_PIPELINE)),
    ).not.toThrow();
  });

  // The real proof: if a future edit reverts `deploy` back to the broken
  // `vercel deploy --prebuilt` promotion, this fails against the on-disk file.
  it('accepts the real, on-disk deploy-website.yml', () => {
    expect(() => assertDeployUsesRemoteBuild(onDiskWorkflow())).not.toThrow();
  });
});

describe('assertPathTriggersIncludeSharedInputs', () => {
  it('rejects a paths filter with no root/shared inputs', () => {
    expect(() =>
      assertPathTriggersIncludeSharedInputs(
        workflow(`
on:
  push:
    paths:
      - 'apps/website/**'
`),
      ),
    ).toThrow(/pnpm-lock\.yaml.*pnpm-workspace\.yaml.*package\.json/s);
  });

  it('rejects a push trigger with no paths filter at all', () => {
    expect(() =>
      assertPathTriggersIncludeSharedInputs(
        workflow(`
on:
  push:
    branches: [main]
`),
      ),
    ).toThrow(/no "paths" filter/);
  });

  it('accepts the real, on-disk deploy-website.yml', () => {
    expect(() =>
      assertPathTriggersIncludeSharedInputs(onDiskWorkflow()),
    ).not.toThrow();
  });

  it('REQUIRED_SHARED_PATH_TRIGGERS includes the website dir and lockfile', () => {
    // Sanity-checks the fixture list itself so a future edit that quietly
    // empties it doesn't turn every test above into a false pass.
    expect(REQUIRED_SHARED_PATH_TRIGGERS).toEqual(
      expect.arrayContaining(['apps/website/**', 'pnpm-lock.yaml']),
    );
  });
});

// Sanity-check that DEPLOY_WORKFLOW_PATH actually resolves to the file this
// suite means to test, independent of the tests above (which would also fail
// if the path were wrong, but for a less obvious reason).
describe('DEPLOY_WORKFLOW_PATH', () => {
  it('resolves to .github/workflows/deploy-website.yml relative to the repo root', () => {
    expect(DEPLOY_WORKFLOW_PATH).toBe(
      join(scriptDir, '..', '.github', 'workflows', 'deploy-website.yml'),
    );
  });
});
