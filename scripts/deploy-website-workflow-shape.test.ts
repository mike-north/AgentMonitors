/**
 * Tests for the production-deploy workflow-shape guard (issue #286):
 * `.github/workflows/deploy-website.yml`'s `deploy` job must `needs:
 * validate`, and `validate` must run the website's typecheck, test suite,
 * and a production build of the exact commit before `deploy` is allowed to
 * start. These assertions parse the *real* workflow file with the `yaml`
 * package — the same GitHub-Actions-YAML input contract CI itself consumes —
 * not a hand-built approximation of its shape.
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
  assertDeployPromotesArtifact,
  assertPathTriggersIncludeSharedInputs,
  assertValidateGatesDeploy,
} from './deploy-website-workflow-shape.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

// Reconstruction of deploy-website.yml as it existed immediately before issue
// #286's fix: `validate` ran only the website's typecheck (no test, no
// build), and the push `paths` filter did not include any root/shared
// inputs. This is the negative-proof fixture — these guard functions MUST
// reject this shape, proving they would have caught the exact gap the issue
// reported, not just validated whatever the fixed file happens to contain.
const PRE_FIX_WORKFLOW_YAML = `
on:
  push:
    branches:
      - main
    paths:
      - 'apps/website/**'
      - '.github/workflows/deploy-website.yml'
  workflow_dispatch: {}

jobs:
  validate:
    name: Validate
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v5
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Type-check website
        run: pnpm --filter @agentmonitors/website check

  deploy:
    name: Deploy to Vercel (production)
    needs: validate
    runs-on: ubuntu-latest
    steps:
      - name: Deploy production
        run: vercel deploy --prod --yes --cwd apps/website
`;

describe('assertValidateGatesDeploy', () => {
  it('rejects the pre-#286 shape: validate only typechecks, never tests or builds', () => {
    const workflow: unknown = parse(PRE_FIX_WORKFLOW_YAML);
    expect(() =>
      assertValidateGatesDeploy(
        workflow as Parameters<typeof assertValidateGatesDeploy>[0],
      ),
    ).toThrow(
      /website test suite.*production build|production build.*website test suite/s,
    );
  });

  it('rejects a deploy job that silently drops `needs: validate`', () => {
    const workflow: unknown = parse(`
jobs:
  validate:
    steps:
      - run: pnpm --filter @agentmonitors/website check
      - run: pnpm --filter @agentmonitors/website test
      - run: vercel build --prod --yes --cwd apps/website
  deploy:
    steps:
      - run: vercel deploy --prebuilt --prod --yes --cwd apps/website
`);
    expect(() =>
      assertValidateGatesDeploy(
        workflow as Parameters<typeof assertValidateGatesDeploy>[0],
      ),
    ).toThrow(/needs: validate/);
  });

  it('rejects a validate job missing only the production build step', () => {
    const workflow: unknown = parse(`
jobs:
  validate:
    steps:
      - run: pnpm --filter @agentmonitors/website check
      - run: pnpm --filter @agentmonitors/website test
  deploy:
    needs: validate
    steps:
      - run: vercel deploy --prebuilt --prod --yes --cwd apps/website
`);
    expect(() =>
      assertValidateGatesDeploy(
        workflow as Parameters<typeof assertValidateGatesDeploy>[0],
      ),
    ).toThrow(/production build/);
  });

  // Regression test for the review finding on #353: `\b` after the script
  // name also matches before `:`, so similarly-prefixed scripts would have
  // satisfied the guard without running the real `check`/`test` scripts.
  it('rejects check:lint / test:unit lookalikes standing in for the real check and test scripts', () => {
    const workflow: unknown = parse(`
jobs:
  validate:
    steps:
      - run: pnpm --filter @agentmonitors/website check:lint
      - run: pnpm --filter @agentmonitors/website test:unit
      - run: vercel build --prod --yes --cwd apps/website
  deploy:
    needs: validate
    steps:
      - run: vercel deploy --prebuilt --prod --yes --cwd apps/website
`);
    expect(() =>
      assertValidateGatesDeploy(
        workflow as Parameters<typeof assertValidateGatesDeploy>[0],
      ),
    ).toThrow(
      /website typecheck.*website test suite|website test suite.*website typecheck/s,
    );
  });

  it('accepts a minimal well-formed gate shape (positive control)', () => {
    const workflow: unknown = parse(`
jobs:
  validate:
    steps:
      - run: pnpm --filter @agentmonitors/website check
      - run: pnpm --filter @agentmonitors/website test
      - run: vercel build --prod --yes --cwd apps/website
  deploy:
    needs: validate
    steps:
      - run: vercel deploy --prebuilt --prod --yes --cwd apps/website
`);
    expect(() =>
      assertValidateGatesDeploy(
        workflow as Parameters<typeof assertValidateGatesDeploy>[0],
      ),
    ).not.toThrow();
  });

  // The real proof: the actual, on-disk workflow file — parsed exactly as CI
  // would parse it — must satisfy the gate. If a future edit silently drops
  // the `needs: validate` link or one of the three validate steps, this test
  // fails.
  it('accepts the real, on-disk deploy-website.yml', () => {
    const raw = readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
    const workflow: unknown = parse(raw);
    expect(() =>
      assertValidateGatesDeploy(
        workflow as Parameters<typeof assertValidateGatesDeploy>[0],
      ),
    ).not.toThrow();
  });
});

describe('assertDeployPromotesArtifact', () => {
  it('rejects the pre-#286 shape: deploy triggers a second remote build instead of promoting an artifact', () => {
    const workflow: unknown = parse(PRE_FIX_WORKFLOW_YAML);
    expect(() =>
      assertDeployPromotesArtifact(
        workflow as Parameters<typeof assertDeployPromotesArtifact>[0],
      ),
    ).toThrow(/must upload the production build artifact/);
  });

  it('rejects a deploy job that downloads the artifact but deploys without --prebuilt', () => {
    const workflow: unknown = parse(`
jobs:
  validate:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: website-vercel-build
          path: apps/website/.vercel/output
  deploy:
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: website-vercel-build
          path: apps/website/.vercel/output
      - run: vercel deploy --prod --yes --cwd apps/website
`);
    expect(() =>
      assertDeployPromotesArtifact(
        workflow as Parameters<typeof assertDeployPromotesArtifact>[0],
      ),
    ).toThrow(/--prebuilt/);
  });

  // Regression tests for the review finding on #353: an existence-only
  // download-artifact check false-passes when deploy downloads an unrelated
  // artifact (or to the wrong path) — `vercel deploy --prebuilt` would then
  // deploy something other than the validated build.
  it('rejects a deploy job that downloads a DIFFERENT artifact than validate uploaded', () => {
    const workflow: unknown = parse(`
jobs:
  validate:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: website-vercel-build
          path: apps/website/.vercel/output
  deploy:
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: some-unrelated-artifact
          path: apps/website/.vercel/output
      - run: vercel deploy --prebuilt --prod --yes --cwd apps/website
`);
    expect(() =>
      assertDeployPromotesArtifact(
        workflow as Parameters<typeof assertDeployPromotesArtifact>[0],
      ),
    ).toThrow(/"name" differs/);
  });

  it('rejects a deploy job that downloads the artifact to the WRONG path', () => {
    const workflow: unknown = parse(`
jobs:
  validate:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: website-vercel-build
          path: apps/website/.vercel/output
  deploy:
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: website-vercel-build
          path: somewhere/else
      - run: vercel deploy --prebuilt --prod --yes --cwd apps/website
`);
    expect(() =>
      assertDeployPromotesArtifact(
        workflow as Parameters<typeof assertDeployPromotesArtifact>[0],
      ),
    ).toThrow(/"path" differs/);
  });

  it('rejects a validate job that never uploads the build artifact', () => {
    const workflow: unknown = parse(`
jobs:
  validate:
    steps:
      - run: vercel build --prod --yes --cwd apps/website
  deploy:
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: website-vercel-build
          path: apps/website/.vercel/output
      - run: vercel deploy --prebuilt --prod --yes --cwd apps/website
`);
    expect(() =>
      assertDeployPromotesArtifact(
        workflow as Parameters<typeof assertDeployPromotesArtifact>[0],
      ),
    ).toThrow(/must upload/);
  });

  it('accepts a deploy job that downloads the artifact validate uploaded and deploys it prebuilt (positive control)', () => {
    const workflow: unknown = parse(`
jobs:
  validate:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: website-vercel-build
          path: apps/website/.vercel/output
  deploy:
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: website-vercel-build
          path: apps/website/.vercel/output
      - run: vercel deploy --prebuilt --prod --yes --cwd apps/website
`);
    expect(() =>
      assertDeployPromotesArtifact(
        workflow as Parameters<typeof assertDeployPromotesArtifact>[0],
      ),
    ).not.toThrow();
  });

  // The real proof: if a future edit reverts `deploy` back to an independent
  // `vercel deploy --prod` remote build, this test fails against the actual
  // on-disk workflow.
  it('accepts the real, on-disk deploy-website.yml', () => {
    const raw = readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
    const workflow: unknown = parse(raw);
    expect(() =>
      assertDeployPromotesArtifact(
        workflow as Parameters<typeof assertDeployPromotesArtifact>[0],
      ),
    ).not.toThrow();
  });
});

describe('assertPathTriggersIncludeSharedInputs', () => {
  it('rejects the pre-#286 shape: no root/shared inputs in the paths filter', () => {
    const workflow: unknown = parse(PRE_FIX_WORKFLOW_YAML);
    expect(() =>
      assertPathTriggersIncludeSharedInputs(
        workflow as Parameters<typeof assertPathTriggersIncludeSharedInputs>[0],
      ),
    ).toThrow(/pnpm-lock\.yaml/);
  });

  it('names every missing required path, not just the first', () => {
    const workflow: unknown = parse(`
on:
  push:
    paths:
      - 'apps/website/**'
`);
    expect(() =>
      assertPathTriggersIncludeSharedInputs(
        workflow as Parameters<typeof assertPathTriggersIncludeSharedInputs>[0],
      ),
    ).toThrow(/pnpm-lock\.yaml.*pnpm-workspace\.yaml.*package\.json/s);
  });

  it('rejects a push trigger with no paths filter at all', () => {
    const workflow: unknown = parse(`
on:
  push:
    branches: [main]
`);
    expect(() =>
      assertPathTriggersIncludeSharedInputs(
        workflow as Parameters<typeof assertPathTriggersIncludeSharedInputs>[0],
      ),
    ).toThrow(/no "paths" filter/);
  });

  it('accepts the real, on-disk deploy-website.yml', () => {
    const raw = readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
    const workflow: unknown = parse(raw);
    expect(() =>
      assertPathTriggersIncludeSharedInputs(
        workflow as Parameters<typeof assertPathTriggersIncludeSharedInputs>[0],
      ),
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
