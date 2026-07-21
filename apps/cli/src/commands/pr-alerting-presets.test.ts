/**
 * Tests for the `pr-review` / `my-prs` PR-alerting presets (issue #444).
 *
 * These drive the **real** `command-poll` source with the **real** scaffolded
 * `watch:` block — the shell wrapper and the `gh` argv are exercised verbatim,
 * with only the `gh` binary itself replaced by a stub on `PATH`. Expected
 * behavior is asserted against the contract in the issue and specs
 * [003 §11](../../../../docs/specs/003-source-plugins.md) /
 * [005 §2](../../../../docs/specs/005-cli-reference.md), not against captured
 * output.
 *
 * @see https://cli.github.com/manual/gh_pr_list — `gh pr list` fields
 * @see https://docs.github.com/en/graphql/reference/enums#statusstate — check conclusions
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseMonitor } from '@agentmonitors/core';
import commandPoll from '@agentmonitors/source-command-poll';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEMPLATES } from './init.js';

/** Where the scaffolded template's `watch:` block lands after parsing. */
type Scope = Record<string, unknown>;

/**
 * Every directory this file's `mkdtempSync` calls create, so a single
 * `afterAll` can remove them all — nothing here is a fixture a later test
 * depends on finding on disk.
 */
const createdTempDirs: string[] = [];

afterAll(() => {
  for (const dir of createdTempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Parse a preset template exactly as `init` scaffolds it and hand back the
 * `watch:` config with `type` stripped — the shape the source receives.
 * Failing here means the shipped template no longer parses, which is the same
 * failure `agentmonitors validate` would report.
 *
 * `parseMonitor(content, filePath)` never reads `filePath` from disk — it
 * only derives the monitor id from its parent directory name (see
 * `libs/core/src/parser/parse-monitor.ts`) — so this passes a synthetic,
 * never-created path rather than actually `mkdtempSync`/`writeFileSync`ing a
 * MONITOR.md nothing reads.
 */
function presetScope(type: 'pr-review' | 'my-prs'): Scope {
  const template = TEMPLATES[type];
  if (template === undefined) throw new Error(`no template for ${type}`);
  const file = path.join(tmpdir(), `am444-parse-${type}`, 'MONITOR.md');
  const parsed = parseMonitor(template, file);
  if (!parsed.ok) {
    throw new Error(
      `preset ${type} failed to parse: ${JSON.stringify(parsed)}`,
    );
  }
  const { type: _sourceType, ...scope } = parsed.monitor.frontmatter.watch as {
    type: string;
  } & Scope;
  return scope;
}

/**
 * Clones `scope` (a `pr-review` scope from {@link presetScope}) with its
 * scaffolded `search='review-requested:@me'` shell-variable assignment
 * replaced, simulating the ONE edit `PR_REVIEW_SCOPE_COMMENT` instructs an
 * author to make to switch reviewer-scoping models. Used to exercise the
 * scope-conditional team-request clause (`discussion_r3624450049`) under a
 * scope other than the default, without hand-writing a second script.
 */
function withSearchScope(scope: Scope, search: string): Scope {
  const command = scope['command'] as string[];
  const edited = command.map((token) =>
    token.replace("search='review-requested:@me'", `search='${search}'`),
  );
  return { ...scope, command: edited };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `am444-${prefix}-`));
  createdTempDirs.push(dir);
  return dir;
}

function writeExecutable(file: string, contents: string): void {
  writeFileSync(file, contents, 'utf-8');
  chmodSync(file, 0o755);
}

/**
 * A `PATH` directory holding a stub `gh` that prints `$AM444_FIXTURE`
 * verbatim and ignores every flag — including `--jq`. Used for the transition
 * tests, whose fixtures are already in the reduced shape the preset's `--jq`
 * program emits, so the assertion is about *which transitions fire*, not about
 * the reduction (that is covered separately below, against raw `gh` JSON).
 *
 * Answers a `gh repo view ...` call with `repoUrl` (plain, unquoted — matching
 * real `gh ... --jq '.url'` raw-string output) and a `gh api ...` call
 * (pr-review's identity resolution — see {@link stubGhApplyingJq}'s doc
 * comment) with `{"login": identityLogin}` rather than the fixture, for the
 * same reason: without this, pr-review's multi-call fetch would slurp extra
 * values instead of the exact `[identity, prs]` pair it expects.
 */
function stubGhEchoingFixture(
  identityLogin = 'octocat',
  repoUrl = 'https://github.com/acme/app',
): string {
  const dir = tempDir('stub');
  writeExecutable(
    path.join(dir, 'gh'),
    `#!/bin/sh\nif [ "$1" = "repo" ]; then\n  printf '%s\\n' '${repoUrl}'\n  exit 0\nfi\nif [ "$1" = "api" ]; then\n  printf '{"login":"${identityLogin}"}\\n'\n  exit 0\nfi\ncat "$AM444_FIXTURE"\n`,
  );
  return dir;
}

/**
 * A `PATH` directory holding a stub `gh` that reads `$AM444_FIXTURE` as **raw**
 * `gh pr list --json` output and pipes it through the preset's own `--jq`
 * program using the real `jq` binary. This is what proves the shipped jq
 * reduction actually maps GitHub's payload onto the diffed shape.
 *
 * `pr-review`'s fetch resolves the repository host via `gh repo view` (PR #446
 * review, thread `discussion_r3617759108`) and then runs `gh api user
 * --hostname "$host" --jq '{login}'` (thread `r3615190027`) before `gh pr
 * list`, to resolve the current `gh` identity for its self-authored-PR
 * exclusion — the stub answers `gh repo view` with `repoUrl` (plain,
 * unquoted, matching real `--jq '.url'` raw-string output), `gh api ...` with
 * `{"login": identityLogin}`, and falls back to the raw fixture for every
 * other `gh` invocation. `my-prs` never calls either, so both branches are
 * inert for every my-prs-only test in this file; `identityLogin` defaults to
 * `'octocat'` to match `rawMyPr`'s default author (representing "me").
 */
function stubGhApplyingJq(
  identityLogin = 'octocat',
  repoUrl = 'https://github.com/acme/app',
): string {
  const dir = tempDir('stub-jq');
  writeExecutable(
    path.join(dir, 'gh'),
    // The shipped presets apply `--jq` as a SEPARATE `jq -sc` stage over
    // `gh`'s raw stdout (see `ghPresetScript`'s `reduceJq` parameter), not
    // as a `gh --jq` flag, so the stub's only job is to hand back the raw
    // fixture verbatim for a `gh pr list` call — the real reduction runs for
    // real, in the script under test, via the real `jq` binary already
    // required by `hasJq`.
    `#!/bin/sh\nif [ "$1" = "repo" ]; then\n  printf '%s\\n' '${repoUrl}'\n  exit 0\nfi\nif [ "$1" = "api" ]; then\n  printf '{"login":"${identityLogin}"}\\n'\n  exit 0\nfi\ncat "$AM444_FIXTURE"\n`,
  );
  return dir;
}

/**
 * A `PATH` directory holding a stub `gh` that mimics real `gh pr list
 * --state <s> --limit <n>` filtering: it reads `$AM444_FIXTURE` as a raw
 * array, keeps only entries whose `.state` matches `--state` case-
 * insensitively, truncates to `--limit`, and prints the result — exactly
 * the per-state, per-call windowing `my-prs`'s three separate `gh` calls
 * rely on (issue #444 review, finding 989). `jq` performs the filter for
 * real rather than a hand-rolled shell parse, since the stub itself needs
 * no `--jq` support (that flag is no longer passed to `gh` at all).
 */
function stubGhFilteringByState(): string {
  const dir = tempDir('stub-state-filter');
  writeExecutable(
    path.join(dir, 'gh'),
    [
      '#!/bin/sh',
      'state=""',
      'limit=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    --state) state="$2" ;;',
      '    --limit) limit="$2" ;;',
      '  esac',
      '  shift',
      'done',
      'jq -c --arg state "$state" --argjson limit "$limit" \'' +
        '[.[] | select((.state // "") | ascii_downcase == $state)] | .[0:$limit]' +
        '\' < "$AM444_FIXTURE"',
      '',
    ].join('\n'),
  );
  return dir;
}

/** `PATH` that finds the stub first and still resolves `sh`. */
function pathWith(stubDir: string): string {
  return `${stubDir}:/usr/bin:/bin`;
}

interface ObserveResult {
  titles: string[];
  stdout: string;
  state: unknown;
}

/**
 * Run one `observe()` against `scope` with `gh` stubbed to serve `fixture`.
 * `previousState` threads the prior tick's state through, exactly as the
 * runtime does.
 */
async function observe(
  scope: Scope,
  stubDir: string,
  fixture: string,
  previousState?: unknown,
): Promise<ObserveResult> {
  const fixtureFile = path.join(tempDir('fixture'), 'fixture.json');
  writeFileSync(fixtureFile, fixture, 'utf-8');
  const result = await commandPoll.observe(
    {
      ...scope,
      env: { PATH: pathWith(stubDir), AM444_FIXTURE: fixtureFile },
    },
    {
      now: new Date('2026-01-15T10:00:00.000Z'),
      ...(previousState === undefined ? {} : { previousState }),
    },
  );
  const state = result.nextState as { stdout?: string } | undefined;
  return {
    titles: result.observations.map((o) => o.title),
    stdout: state?.stdout ?? '',
    state: result.nextState,
  };
}

/**
 * Baseline on `before`, then tick again on `after`. Returns the second tick's
 * observation titles — the runtime's first successful run always baselines
 * silently (003 §11.4), so a transition is only observable on the second.
 */
async function transition(
  scope: Scope,
  stubDir: string,
  before: string,
  after: string,
): Promise<string[]> {
  const baseline = await observe(scope, stubDir, before);
  expect(baseline.titles).toEqual([]);
  const next = await observe(scope, stubDir, after, baseline.state);
  return next.titles;
}

/**
 * One entry in `my-prs`'s **actionable** payload. A PR appears only while it
 * needs the author to do something; `needs` says which class it is.
 */
interface MyPrEntry {
  number: number;
  title: string;
  url: string;
  needs: 'ci-failing' | 'changes-requested' | 'draft' | 'merged' | 'closed';
  failingChecks?: string[];
  reviews?: { by: string; state: string }[];
  commentCount?: number;
}

/** An open PR whose CI is red — the canonical actionable entry. */
function myPr(overrides: Partial<MyPrEntry> = {}): MyPrEntry {
  return {
    number: 101,
    title: 'feat: add widget',
    url: 'https://github.com/acme/app/pull/101',
    needs: 'ci-failing',
    failingChecks: ['build'],
    reviews: [],
    commentCount: 0,
    ...overrides,
  };
}

function fixtureOf(entries: unknown[]): string {
  return `${JSON.stringify(entries)}\n`;
}

const CHANGED = 'Command output changed: my-prs';
const CHANGED_REVIEW = 'Command output changed: pr-review';

/**
 * The shipped `--jq` reduction, run for real. `jq` is preinstalled on the
 * `ubuntu-latest` runner every CI job uses, so this coverage is never
 * supposed to be skipped in CI — the guard below only spares a contributor
 * whose local machine lacks `jq`.
 */
const hasJq = (() => {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// `describe.skipIf(!hasJq)` would silently report this entire suite as
// SKIPPED rather than FAILED if a CI runner ever lost its `jq` install —
// the one environment where that must be loud. Instead the suite always
// registers; when `jq` is missing, it registers a single test that only
// throws when `process.env.CI` is set (so a jq-less local machine still
// gets a quiet, explicit pass rather than a spurious failure) and returns
// before registering the real jq-dependent tests, which would otherwise
// fail with a much less legible "jq: command not found" per test.
describe('the presets’ jq reduction over raw gh output', () => {
  if (!hasJq) {
    it('requires jq to be installed', () => {
      if (process.env.CI) {
        throw new Error(
          'jq was not found on PATH. This suite must run for real in CI ' +
            '(the ubuntu-latest runner ships jq) — check the runner image ' +
            'or install step rather than silently skipping this coverage.',
        );
      }
      // Not CI: no jq on a contributor's machine is expected; this test
      // passing (without exercising real jq) is the intended no-op.
    });
    return;
  }

  /**
   * A raw `gh pr list --json ...` element for the `pr-review` preset,
   * authored by someone OTHER than the current identity (`'contributor'`,
   * distinct from `rawMyPr`'s `'octocat'` — see {@link stubGhApplyingJq}'s
   * default `identityLogin`) — the ordinary case: a PR you did not write,
   * that needs your review. Tests of the self-authored-exclusion itself pass
   * an explicit `author: { login: 'octocat' }` override.
   */
  function rawReviewPr(overrides: Record<string, unknown> = {}): unknown {
    return {
      number: 7,
      title: 'fix: thing',
      isDraft: false,
      reviewDecision: '',
      headRefName: 'fix/thing',
      author: {
        id: 'MDQ7',
        is_bot: false,
        login: 'contributor',
        name: 'A Contributor',
      },
      ...overrides,
    };
  }

  /** A raw `gh pr list --json ...` element for the `my-prs` preset. */
  function rawMyPr(overrides: Record<string, unknown> = {}): unknown {
    return {
      number: 101,
      title: 'feat: add widget',
      url: 'https://github.com/acme/app/pull/101',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: '',
      statusCheckRollup: [],
      latestReviews: [],
      comments: [],
      mergedAt: null,
      closedAt: null,
      author: { login: 'octocat' },
      ...overrides,
    };
  }

  /**
   * An ISO timestamp `secondsAgo` before now. The terminal-state filter is
   * evaluated by `jq`'s `now` against the real wall clock, so these fixtures
   * cannot use a frozen constant — the offset is what the assertion is about.
   */
  function ago(secondsAgo: number): string {
    // Second precision, matching what the GitHub API actually returns.
    // `jq`'s `fromdateiso8601` rejects fractional seconds outright, which is
    // why the query strips them defensively — see the `.[0-9]+Z` sub there.
    return `${new Date(Date.now() - secondsAgo * 1000)
      .toISOString()
      .slice(0, 19)}Z`;
  }

  /** Merged/closed recently enough to still be actionable (window is 6h). */
  const JUST_MERGED = { state: 'MERGED', mergedAt: ago(60) };
  const JUST_CLOSED = { state: 'CLOSED', closedAt: ago(60) };

  function checkRun(
    name: string,
    conclusion: string,
    status = 'COMPLETED',
  ): Record<string, unknown> {
    return {
      __typename: 'CheckRun',
      name,
      status,
      conclusion,
      detailsUrl: `https://github.com/acme/app/runs/${name}`,
      startedAt: '2026-01-15T09:00:00Z',
      completedAt: '2026-01-15T09:05:00Z',
    };
  }

  /** The green, non-draft, undecided open PR that must never enter `my-prs`. */
  const QUIET = { statusCheckRollup: [checkRun('build', 'SUCCESS')] };

  describe('`--type my-prs` fires on every actionable transition', () => {
    let scope: Scope;
    let stub: string;
    beforeAll(() => {
      scope = presetScope('my-prs');
      stub = stubGhApplyingJq();
    });

    it('fires when CI goes green -> red, and names the failing check', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(QUIET)]),
        fixtureOf([
          rawMyPr({ statusCheckRollup: [checkRun('build', 'FAILURE')] }),
        ]),
      );
      expect(titles).toEqual([CHANGED]);

      const red = await observe(
        scope,
        stub,
        fixtureOf([
          rawMyPr({ statusCheckRollup: [checkRun('build', 'FAILURE')] }),
        ]),
      );
      expect(JSON.parse(red.stdout)).toEqual([
        {
          number: 101,
          url: 'https://github.com/acme/app/pull/101',
          needs: 'ci-failing',
          failingChecks: ['build'],
          reviews: [],
          commentCount: 0,
        },
      ]);
      // title is deliberately absent from the diffed payload — see the
      // retitle-while-actionable regression below (PR #446 review, thread
      // discussion_r3617759355).
      expect(red.stdout).not.toContain('feat: add widget');
    });

    it('fires when reviewDecision becomes CHANGES_REQUESTED', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(QUIET)]),
        fixtureOf([rawMyPr({ ...QUIET, reviewDecision: 'CHANGES_REQUESTED' })]),
      );
      expect(titles).toEqual([CHANGED]);
    });

    it('fires when more feedback lands on a PR already needing changes', async () => {
      const base = { ...QUIET, reviewDecision: 'CHANGES_REQUESTED' };
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(base)]),
        fixtureOf([rawMyPr({ ...base, comments: [{ body: 'one more' }] })]),
      );
      expect(titles).toEqual([CHANGED]);
    });

    it('does NOT fire when only the author’s own comment lands on a PR already needing changes (PR #446 review)', async () => {
      const base = { ...QUIET, reviewDecision: 'CHANGES_REQUESTED' };
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(base)]),
        fixtureOf([
          rawMyPr({
            ...base,
            comments: [{ author: { login: 'octocat' }, body: 'ack, on it' }],
          }),
        ]),
      );
      expect(titles).toEqual([]);
    });

    it('does NOT fire when only a bot comment lands on a PR already needing changes (PR #446 review)', async () => {
      const base = { ...QUIET, reviewDecision: 'CHANGES_REQUESTED' };
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(base)]),
        fixtureOf([
          rawMyPr({
            ...base,
            comments: [
              { author: { login: 'dependabot[bot]' }, body: 'rebased' },
            ],
          }),
        ]),
      );
      expect(titles).toEqual([]);
    });

    it('fires when a reviewer (not the author, not a bot) comments on a PR already needing changes', async () => {
      const base = { ...QUIET, reviewDecision: 'CHANGES_REQUESTED' };
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(base)]),
        fixtureOf([
          rawMyPr({
            ...base,
            comments: [
              { author: { login: 'reviewer-bob' }, body: 'still blocking' },
            ],
          }),
        ]),
      );
      expect(titles).toEqual([CHANGED]);

      const observed = await observe(
        scope,
        stub,
        fixtureOf([
          rawMyPr({
            ...base,
            comments: [
              { author: { login: 'reviewer-bob' }, body: 'still blocking' },
              { author: { login: 'octocat' }, body: 'my own reply' },
              {
                author: { login: 'copilot-pull-request-reviewer[bot]' },
                body: 'bot note',
              },
            ],
          }),
        ]),
      );
      const [entry] = JSON.parse(observed.stdout) as { commentCount: number }[];
      // Only reviewer-bob's comment counts: octocat is the PR author, and the
      // copilot reviewer is a bot ([bot]-suffixed login).
      expect(entry?.commentCount).toBe(1);
    });

    it('fires when isDraft goes false -> true (pulled back to draft)', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(QUIET)]),
        fixtureOf([rawMyPr({ ...QUIET, isDraft: true })]),
      );
      expect(titles).toEqual([CHANGED]);
    });

    it('fires when isDraft goes true -> false (marked ready)', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr({ ...QUIET, isDraft: true })]),
        fixtureOf([rawMyPr(QUIET)]),
      );
      expect(titles).toEqual([CHANGED]);
    });

    /**
     * Characterization test for issue #444 review, finding 824: a PR
     * opened directly as a draft (the author's OWN, deliberate first
     * action) is indistinguishable from "someone pulled a ready PR back to
     * draft" — both are `false -> true` (or, on the very first tick, an
     * entering-membership) transitions on the same `isDraft` field, and
     * `command-poll`'s stateless `json-diff` polling carries no history
     * that would let a preset tell them apart. This is a documented,
     * accepted limitation (003 §11.9's `my-prs` body already tells the
     * author how to disambiguate: "if you did not just put it there,
     * someone pulled it back"), not a defect — pinning it here as a
     * characterization test (rather than leaving it unasserted) is what
     * keeps that documentation accurate if the reduction's `draft` handling
     * ever changes.
     */
    it('fires for a PR opened directly as a draft, indistinguishable from a pulled-back PR (issue #444 review, finding 824)', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([]),
        fixtureOf([rawMyPr({ ...QUIET, isDraft: true })]),
      );
      expect(titles).toEqual([CHANGED]);
      const [entry] = JSON.parse(
        (
          await observe(
            scope,
            stub,
            fixtureOf([rawMyPr({ ...QUIET, isDraft: true })]),
          )
        ).stdout,
      ) as { needs: string }[];
      expect(entry?.needs).toBe('draft');
    });

    it('fires when state becomes MERGED', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(QUIET)]),
        fixtureOf([rawMyPr({ ...QUIET, ...JUST_MERGED })]),
      );
      expect(titles).toEqual([CHANGED]);
    });

    it('fires when state becomes CLOSED', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(QUIET)]),
        fixtureOf([rawMyPr({ ...QUIET, ...JUST_CLOSED })]),
      );
      expect(titles).toEqual([CHANGED]);
    });

    // The whole reason `--state all` is kept despite costing window slots:
    // "merged, clean up" and "closed unmerged, find out why" are different
    // instructions, and `--state open` collapses both into a disappearance.
    it('names MERGED and CLOSED distinguishably, and keeps terminal entries static', async () => {
      const merged = await observe(
        scope,
        stub,
        fixtureOf([rawMyPr({ ...QUIET, ...JUST_MERGED })]),
      );
      expect(JSON.parse(merged.stdout)).toEqual([
        {
          number: 101,
          url: 'https://github.com/acme/app/pull/101',
          needs: 'merged',
        },
      ]);
      const closed = await observe(
        scope,
        stub,
        fixtureOf([rawMyPr({ ...QUIET, ...JUST_CLOSED })]),
      );
      expect((JSON.parse(closed.stdout) as { needs: string }[])[0]?.needs).toBe(
        'closed',
      );
    });

    it('fires when CI recovers, as an entry leaving the list', async () => {
      // Not actionable, but not swallowed either — the body tells the agent to
      // note it and move on.
      const titles = await transition(
        scope,
        stub,
        fixtureOf([
          rawMyPr({ statusCheckRollup: [checkRun('build', 'FAILURE')] }),
        ]),
        fixtureOf([rawMyPr(QUIET)]),
      );
      expect(titles).toEqual([CHANGED]);
    });

    it('treats a legacy StatusContext FAILURE as actionable', async () => {
      const result = await observe(
        scope,
        stub,
        fixtureOf([
          rawMyPr({
            statusCheckRollup: [
              {
                __typename: 'StatusContext',
                context: 'ci/legacy',
                state: 'FAILURE',
              },
            ],
          }),
        ]),
      );
      expect(
        (JSON.parse(result.stdout) as { failingChecks: string[] }[])[0]
          ?.failingChecks,
      ).toEqual(['ci/legacy']);
    });
  });

  /**
   * The silence guarantees. These are the entire safety argument for `high`
   * urgency: if any of these fired, a high-urgency author monitor would
   * interrupt the agent mid-turn on a non-event.
   */
  describe('`--type my-prs` review-revision signal (PR #446 review, thread 2)', () => {
    let scope: Scope;
    let stub: string;
    beforeAll(() => {
      scope = presetScope('my-prs');
      stub = stubGhApplyingJq();
    });

    function review(state: string, submittedAt: string): unknown {
      return {
        author: { login: 'octocat' },
        state,
        submittedAt,
        body: 'body text, deliberately not part of the diffed payload',
      };
    }

    // The defect: reducing each latest review to only {by, state} made a SECOND
    // CHANGES_REQUESTED from the SAME reviewer invisible — reviewDecision, the
    // reduced array, and commentCount were all unchanged, so json-diff emitted
    // nothing even though new blocking feedback had landed.
    it('fires on repeat feedback from the same reviewer in the same state', async () => {
      const base = { ...QUIET, reviewDecision: 'CHANGES_REQUESTED' };
      const titles = await transition(
        scope,
        stub,
        fixtureOf([
          rawMyPr({
            ...base,
            latestReviews: [
              review('CHANGES_REQUESTED', '2026-01-15T09:00:00Z'),
            ],
          }),
        ]),
        fixtureOf([
          rawMyPr({
            ...base,
            latestReviews: [
              review('CHANGES_REQUESTED', '2026-01-15T11:30:00Z'),
            ],
          }),
        ]),
      );
      expect(titles).toEqual([CHANGED]);
    });

    it('carries submittedAt as the revision signal, and never the review body', async () => {
      const result = await observe(
        scope,
        stub,
        fixtureOf([
          rawMyPr({
            ...QUIET,
            reviewDecision: 'CHANGES_REQUESTED',
            latestReviews: [
              review('CHANGES_REQUESTED', '2026-01-15T09:00:00Z'),
            ],
          }),
        ]),
      );
      const [entry] = JSON.parse(result.stdout) as {
        reviews: { by: string; state: string; at: string }[];
      }[];
      expect(entry?.reviews).toEqual([
        {
          by: 'octocat',
          state: 'CHANGES_REQUESTED',
          at: '2026-01-15T09:00:00Z',
        },
      ]);
      expect(result.stdout).not.toContain('deliberately not part');
    });

    // submittedAt is fixed at submission, so unlike updatedAt it cannot churn
    // between polls — the revision signal must not itself become a diff source.
    it('does NOT fire when an unchanged review is re-observed', async () => {
      const same = {
        ...QUIET,
        reviewDecision: 'CHANGES_REQUESTED',
        latestReviews: [review('CHANGES_REQUESTED', '2026-01-15T09:00:00Z')],
      };
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(same)]),
        fixtureOf([rawMyPr(same)]),
      );
      expect(titles).toEqual([]);
    });
  });

  /**
   * Regression coverage for issue #444 review finding 989: a single
   * `--state all --limit N` call orders newest-created-first across every
   * state, so merged/closed history competes with open PRs for the SAME
   * window — on an active repository, terminal rows measured 15 of 20
   * slots at `--limit 20`, aging a still-open PR out of the query entirely
   * (after which its CI going red would silently produce no event, ever,
   * until it re-entered the window). `my-prs` now fetches `--state open`,
   * `--state merged`, and `--state closed` as three SEPARATE `gh` calls,
   * each with its own `--limit`, so open coverage can never be displaced by
   * terminal volume. `stubGhFilteringByState` mimics real `gh`'s per-call
   * state filtering (the other tests in this file don't need to — they use
   * a single fixture that the stub hands back verbatim for every call,
   * relying on `unique_by(.number)` to make the repetition harmless), which
   * is what lets this test actually reproduce the eviction the old,
   * single-call design was vulnerable to.
   */
  describe('`--type my-prs` open-PR coverage survives terminal-history volume (PR #446 review, finding 989)', () => {
    it('still surfaces a still-open, ci-failing PR after 99 newer merged PRs', async () => {
      const scope = presetScope('my-prs');
      const stub = stubGhFilteringByState();

      // 99 merged PRs, newest-first (as real `gh pr list` orders them) —
      // comfortably past the OLD design's single-call `--limit 60`, which
      // would have evicted the open PR below entirely (it was never fetched
      // at all, let alone diffed).
      const mergedHistory = Array.from({ length: 99 }, (_, i) =>
        rawMyPr({
          number: 1000 + i,
          state: 'MERGED',
          mergedAt: ago(3600 * (i + 1)),
        }),
      );
      // The oldest-created (and therefore last-in-array, under newest-first
      // ordering) PR in the fixture: still open, and its CI just went red.
      const stillOpenCiFailing = rawMyPr({
        number: 1,
        state: 'OPEN',
        statusCheckRollup: [checkRun('build', 'FAILURE')],
      });
      const fixture = fixtureOf([...mergedHistory, stillOpenCiFailing]);

      const baseline = await observe(scope, stub, fixture);
      // A dedicated `--state open` call fetches this PR regardless of how
      // much merged history exists, so it is visible on the very first
      // (baselining) tick already — nothing to diff away.
      const [entry] = JSON.parse(baseline.stdout) as { number: number }[];
      expect(entry?.number).toBe(1);

      // And it keeps firing on a real transition, exactly like any other
      // actionable PR — this is not a baseline-only artifact.
      const recovered = rawMyPr({ number: 1, state: 'OPEN', ...QUIET });
      const next = await observe(
        scope,
        stub,
        fixtureOf([...mergedHistory, recovered]),
        baseline.state,
      );
      expect(next.titles).toEqual([CHANGED]);
    });

    /**
     * PR #446 review, 21:43 round (main review body): 003 §11.9 had drifted
     * to describe the OLD `--limit 30` bound while the implementation and
     * 004 already say `1000`, and the test above (99 merged rows, but only
     * ONE open row) passed unchanged under either bound — it never actually
     * proved the query carries the new limit. This is the exact argv
     * assertion the review accepted as an alternative to a 31+-concurrent-
     * open fixture.
     */
    it('requests the open-state call with the documented 1000 bound, not the superseded 30', () => {
      const command = (presetScope('my-prs')['command'] as string[]).join(' ');
      expect(command).toContain('--state open --limit 1000');
      expect(command).not.toMatch(/--state open --limit 30\b/);
    });
  });

  /**
   * PR #446 review, thread `discussion_r3617759463`: `gh pr list` without
   * `--search` orders newest-CREATED-first, not newest-merged/closed-first,
   * so a fixed `--limit` on the merged/closed calls can miss an OLDER PR that
   * only just entered the terminal window. The fetch now scopes those two
   * calls to a `merged:`/`closed:` search date range computed from
   * {@link TERMINAL_WINDOW_SECONDS} instead, which this argv-level assertion
   * proves is actually wired up (the REDUCE-level time-bound tests above
   * exercise the jq filter, not the fetch query that feeds it).
   */
  describe('`--type my-prs` terminal fetch is date-scoped, not order-and-limit-scoped (PR #446 review, thread discussion_r3617759463)', () => {
    it('computes a portable cutoff and scopes both terminal calls to it', () => {
      const command = (presetScope('my-prs')['command'] as string[]).join(' ');
      // Portable cutoff: tries GNU `date -d @epoch` first, falls back to
      // BSD/macOS `date -r epoch` — the same script must run on both.
      expect(command).toContain('date -u -d @"$cutoff_epoch"');
      expect(command).toContain('date -u -r "$cutoff_epoch"');
      expect(command).toContain('--state merged --search "merged:>=$cutoff"');
      expect(command).toContain(
        '--state closed --search "closed:>=$cutoff -is:merged"',
      );
    });

    // `-is:merged` on the closed lane specifically guards against the
    // reviewer's measured `gh` behavior: once `--search` is present, `gh`
    // routes through the search API, whose `is:closed` qualifier (unlike the
    // plain `--state closed` GraphQL filter alone) also matches merged PRs.
    it('excludes merged PRs from the closed-state search, not just the open one', () => {
      const command = (presetScope('my-prs')['command'] as string[]).join(' ');
      expect(command).toMatch(/closed:>=\$cutoff -is:merged/);
    });
  });

  describe('`--type my-prs` terminal states are time-bounded', () => {
    let scope: Scope;
    let stub: string;
    beforeAll(() => {
      scope = presetScope('my-prs');
      stub = stubGhApplyingJq();
    });

    it('drops a PR merged longer ago than the 6h window', async () => {
      const stale = await observe(
        scope,
        stub,
        fixtureOf([
          rawMyPr({ ...QUIET, state: 'MERGED', mergedAt: ago(7 * 3600) }),
        ]),
      );
      expect(JSON.parse(stale.stdout)).toEqual([]);
    });

    it('keeps a PR merged inside the window', async () => {
      const fresh = await observe(
        scope,
        stub,
        fixtureOf([rawMyPr({ ...QUIET, ...JUST_MERGED })]),
      );
      expect(JSON.parse(fresh.stdout)).toHaveLength(1);
    });

    // Without the time bound, terminal rows accumulate until they fall out of
    // --limit, so every new merge evicts an older one and emits a spurious
    // removal diff — a spurious interrupt at high urgency.
    it('does NOT fire when a long-since-merged PR is present across polls', async () => {
      const old = { ...QUIET, state: 'MERGED', mergedAt: ago(48 * 3600) };
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(old)]),
        fixtureOf([rawMyPr(old), rawMyPr({ ...old, number: 99 })]),
      );
      expect(titles).toEqual([]);
    });

    // GitHub returns second-precision timestamps, but `fromdateiso8601`
    // errors outright on fractional seconds — an unhandled error would take
    // the whole monitor down, so the query strips them and fails open.
    it('tolerates a fractional-second timestamp', async () => {
      const withMillis = `${new Date(Date.now() - 60_000)
        .toISOString()
        .slice(0, 19)}.123Z`;
      const result = await observe(
        scope,
        stub,
        fixtureOf([
          rawMyPr({ ...QUIET, state: 'MERGED', mergedAt: withMillis }),
        ]),
      );
      expect(JSON.parse(result.stdout)).toHaveLength(1);
    });

    // Fail open: an unparseable timestamp keeps the row rather than silently
    // dropping a merge the author still needs to act on.
    it('keeps a terminal PR whose timestamp cannot be parsed', async () => {
      const result = await observe(
        scope,
        stub,
        fixtureOf([
          rawMyPr({ ...QUIET, state: 'MERGED', mergedAt: 'not-a-timestamp' }),
        ]),
      );
      expect(JSON.parse(result.stdout)).toHaveLength(1);
    });

    // Trap: any timestamp left in the payload changes on essentially every
    // poll and would fire continuously. mergedAt/closedAt are filter-only.
    it('emits no timestamp field into the diffed payload', async () => {
      const result = await observe(
        scope,
        stub,
        fixtureOf([
          rawMyPr({ ...QUIET, ...JUST_MERGED }),
          rawMyPr({ ...QUIET, number: 102 }),
        ]),
      );
      expect(result.stdout).not.toContain('mergedAt');
      expect(result.stdout).not.toContain('closedAt');
      expect(result.stdout).not.toContain('updatedAt');
      // An ISO-8601 timestamp anywhere outside the review revision signal.
      const entries = JSON.parse(result.stdout) as Record<string, unknown>[];
      for (const entry of entries) {
        for (const [field, value] of Object.entries(entry)) {
          if (field === 'reviews') continue;
          expect(String(value)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
        }
      }
    });
  });

  describe('`--type my-prs` stays silent on non-events', () => {
    let scope: Scope;
    let stub: string;
    beforeAll(() => {
      scope = presetScope('my-prs');
      stub = stubGhApplyingJq();
    });

    it('does NOT fire on a benign PENDING -> PASSING transition', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([
          rawMyPr({
            statusCheckRollup: [
              {
                __typename: 'CheckRun',
                name: 'build',
                status: 'IN_PROGRESS',
                conclusion: '',
              },
            ],
          }),
        ]),
        fixtureOf([rawMyPr(QUIET)]),
      );
      expect(titles).toEqual([]);
    });

    it('stays silent across a full push -> queued -> running -> green cycle', async () => {
      const cycle = [
        [checkRun('build', 'SUCCESS')],
        [
          {
            __typename: 'CheckRun',
            name: 'build',
            status: 'QUEUED',
            conclusion: '',
          },
        ],
        [
          {
            __typename: 'CheckRun',
            name: 'build',
            status: 'IN_PROGRESS',
            conclusion: '',
            startedAt: '2026-01-15T09:02:00Z',
          },
        ],
        [checkRun('build', 'SUCCESS', 'COMPLETED')],
      ];
      let previous: unknown;
      const firedAt: number[] = [];
      for (const [index, rollup] of cycle.entries()) {
        const result = await observe(
          scope,
          stub,
          fixtureOf([rawMyPr({ statusCheckRollup: rollup })]),
          previous,
        );
        if (result.titles.length > 0) firedAt.push(index);
        previous = result.state;
      }
      expect(firedAt).toEqual([]);
    });

    it('does NOT fire when a healthy new PR of your own is opened', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(QUIET)]),
        fixtureOf([rawMyPr(QUIET), rawMyPr({ ...QUIET, number: 102 })]),
      );
      expect(titles).toEqual([]);
    });

    it('does NOT fire when a healthy PR is approved', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(QUIET)]),
        fixtureOf([rawMyPr({ ...QUIET, reviewDecision: 'APPROVED' })]),
      );
      expect(titles).toEqual([]);
    });

    it('does NOT fire when a healthy PR is retitled or gains a comment', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(QUIET)]),
        fixtureOf([
          rawMyPr({
            ...QUIET,
            title: 'feat: add widget (v2)',
            comments: [{ b: 1 }],
          }),
        ]),
      );
      expect(titles).toEqual([]);
    });

    it('does NOT fire when a merged PR gains post-merge comments', async () => {
      const merged = { ...QUIET, ...JUST_MERGED };
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(merged)]),
        fixtureOf([
          rawMyPr({
            ...merged,
            comments: [{ b: 1 }, { b: 2 }],
            latestReviews: [
              { author: { login: 'octocat' }, state: 'COMMENTED' },
            ],
          }),
        ]),
      );
      expect(titles).toEqual([]);
    });

    // PR #446 review, thread `discussion_r3617759355`: the prior retitle test
    // above only covers a QUIET PR that is ABSENT from the payload before and
    // after — it cannot catch a title change churning an entry that is
    // already, and remains, a MEMBER, which is exactly what json-diff (a
    // whole-payload diff) would otherwise re-fire on.
    it('does NOT fire when an already-actionable PR is retitled', async () => {
      const ciFailing = {
        ...QUIET,
        statusCheckRollup: [checkRun('build', 'FAILURE')],
      };
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(ciFailing)]),
        fixtureOf([
          rawMyPr({ ...ciFailing, title: 'feat: add widget (renamed)' }),
        ]),
      );
      expect(titles).toEqual([]);
    });
  });

  /**
   * Issue #441 measured what happens when two monitors watch overlapping
   * state: one merge delivered a high-urgency interrupt, an ack, a normal
   * reminder, and another ack — ~15 round-trips across a 5-PR merge train.
   * Shipping two presets that a user is expected to enable together makes that
   * reproducible by construction unless their payloads are disjoint — not just
   * at a snapshot, but permanently, since PR authorship never changes.
   *
   * The server-side `--search` scope alone does NOT guarantee disjointness: it
   * does under the default (`review-requested:@me` cannot match your own PR,
   * since GitHub forbids requesting review from yourself), but not under the
   * label-driven model, which is the only one that works when author and
   * reviewer share an identity. Disjointness therefore has to hold in the
   * payload filters — specifically, `pr-review`'s self-authored-PR exclusion
   * (PR #446 review, thread `r3615190027`), which `stubGhApplyingJq`'s default
   * `identityLogin` ('octocat', matching `rawMyPr`'s author) and
   * `rawReviewPr`'s default author ('contributor', a DIFFERENT identity)
   * exist specifically to exercise: a fixture merging `rawMyPr` and
   * `rawReviewPr` with an explicit `author: { login: 'octocat' }` override
   * represents "a PR that is mine, but would otherwise also match the
   * reviewer queue" — the exact shape issue #441's interrupt-multiplier
   * needs to reproduce.
   */
  describe('the two presets do not overlap (issue #441 interrupt multiplier)', () => {
    let reviewScope: Scope;
    let mineScope: Scope;
    let stub: string;
    beforeAll(() => {
      reviewScope = presetScope('pr-review');
      mineScope = presetScope('my-prs');
      stub = stubGhApplyingJq();
    });

    /** `rawMyPr`/`rawReviewPr` fields merged onto one PR authored by the
     * current identity — the only shape that could ever cross between the
     * two payloads before the self-authored exclusion existed. */
    function myOwnPr(pr: Record<string, unknown>): unknown {
      return {
        ...(rawMyPr(pr) as object),
        ...(rawReviewPr(pr) as object),
        author: { login: 'octocat' },
      };
    }

    /** Every PR state that could plausibly land in either payload. */
    const states: { label: string; pr: Record<string, unknown> }[] = [
      { label: 'green + undecided', pr: { ...QUIET } },
      {
        label: 'ci failing',
        pr: { statusCheckRollup: [checkRun('build', 'FAILURE')] },
      },
      {
        label: 'changes requested',
        pr: { ...QUIET, reviewDecision: 'CHANGES_REQUESTED' },
      },
      { label: 'draft', pr: { ...QUIET, isDraft: true } },
      { label: 'approved', pr: { ...QUIET, reviewDecision: 'APPROVED' } },
    ];

    it.each(states)(
      'a PR that is $label, authored by the current identity, appears in at most one payload',
      async ({ pr }) => {
        const raw = fixtureOf([myOwnPr(pr)]);
        const inReview = JSON.parse(
          (await observe(reviewScope, stub, raw)).stdout,
        ) as unknown[];
        const inMine = JSON.parse(
          (await observe(mineScope, stub, raw)).stdout,
        ) as unknown[];
        expect(inReview.length + inMine.length).toBeLessThanOrEqual(1);
      },
    );

    it('excludes a PR authored by the current identity from the review queue, even when otherwise review-ready (PR #446 review, thread r3615190027)', async () => {
      const raw = fixtureOf([myOwnPr(QUIET)]);
      expect(
        JSON.parse((await observe(reviewScope, stub, raw)).stdout),
      ).toEqual([]);
      expect(JSON.parse((await observe(mineScope, stub, raw)).stdout)).toEqual(
        [],
      ); // QUIET is green/non-draft/undecided: `needs: none` in my-prs too.
    });

    // A red, undecided, non-draft PR authored by someone ELSE: `pr-review`
    // excludes it on its own second clause (failing CI, independent of
    // authorship — see the preset's own doc comment). `my-prs` never sees a
    // third-party PR like this in production at all — `--author @me` filters
    // it server-side before `gh` prints anything — so there is nothing
    // meaningful to assert against `mineScope` here (the stub, unlike real
    // `gh`, does not enforce `--author`; that flag's presence is asserted at
    // the argv level in "preset portability guarantees" instead).
    it('gives a red undecided PR authored by someone else to neither preset via the review queue', async () => {
      const raw = fixtureOf([
        rawReviewPr({ statusCheckRollup: [checkRun('build', 'FAILURE')] }),
      ]);
      expect(
        JSON.parse((await observe(reviewScope, stub, raw)).stdout),
      ).toEqual([]);
    });

    /**
     * Regression test for PR #446 review, thread `discussion_r3615190027`.
     * An earlier revision's disjointness held only at a snapshot: `pr-review`
     * and `my-prs` are two independently scheduled `command-poll` monitors,
     * each diffing its own payload against its own prior baseline, so a
     * single real-world event that moved a PR across the OLD readiness-only
     * partition could still produce one diff on EACH monitor in the same
     * tick under a same-identity reviewer scope — `pr-review` losing the PR,
     * `my-prs` gaining it, both firing for one CI failure.
     *
     * That crossing is no longer reachable, under ANY scoping model: a PR
     * authored by the current identity can never enter `pr-review`'s payload
     * on any tick (the exclusion in {@link PR_REVIEW_REDUCE} — see
     * `init.ts` — runs before every other filter and does not depend on
     * `--search`), so it was never eligible to leave it either. `pr-review`
     * therefore never even fires across this transition; only `my-prs`,
     * which is the PR's only possible home, does.
     */
    it('a CI failure on the current identity’s own PR fires only my-prs, never pr-review (PR #446 review, thread r3615190027)', async () => {
      const green = myOwnPr(QUIET);
      const red = myOwnPr({
        statusCheckRollup: [checkRun('build', 'FAILURE')],
      });

      const reviewBaseline = await observe(
        reviewScope,
        stub,
        fixtureOf([green]),
      );
      const mineBaseline = await observe(mineScope, stub, fixtureOf([green]));
      // pr-review never claims this PR — not even at baseline, since it is
      // authored by the current identity regardless of readiness.
      expect(JSON.parse(reviewBaseline.stdout)).toEqual([]);
      // Green/undecided/non-draft is `needs: none` in my-prs too.
      expect(JSON.parse(mineBaseline.stdout)).toEqual([]);

      const reviewAfter = await observe(
        reviewScope,
        stub,
        fixtureOf([red]),
        reviewBaseline.state,
      );
      const mineAfter = await observe(
        mineScope,
        stub,
        fixtureOf([red]),
        mineBaseline.state,
      );

      // pr-review: [] -> [] — the PR was never eligible, so there is nothing
      // to lose, and nothing fires.
      expect(reviewAfter.titles).toEqual([]);
      expect(JSON.parse(reviewAfter.stdout)).toEqual([]);
      // my-prs: [] -> [PR, needs: ci-failing] — the only fire for this event.
      expect(mineAfter.titles).toEqual([CHANGED]);
      const [entry] = JSON.parse(mineAfter.stdout) as { needs: string }[];
      expect(entry?.needs).toBe('ci-failing');
    });
  });

  describe('`--type pr-review` reviewer queue', () => {
    let scope: Scope;
    let stub: string;
    beforeAll(() => {
      scope = presetScope('pr-review');
      stub = stubGhApplyingJq();
    });

    it('fires when a non-draft PR appears, and projects author to a login', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([]),
        fixtureOf([rawReviewPr()]),
      );
      expect(titles).toEqual([CHANGED_REVIEW]);

      const result = await observe(scope, stub, fixtureOf([rawReviewPr()]));
      expect(JSON.parse(result.stdout)).toEqual([
        {
          number: 7,
          headRefName: 'fix/thing',
          author: 'contributor',
        },
      ]);
      // title is deliberately absent — see the retitle-while-in-queue
      // regression below (PR #446 review, thread discussion_r3617759355).
      expect(result.stdout).not.toContain('fix: thing');
    });

    it('fires when a draft is marked ready', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawReviewPr({ isDraft: true })]),
        fixtureOf([rawReviewPr({ isDraft: false })]),
      );
      expect(titles).toEqual([CHANGED_REVIEW]);
    });

    it('fires when a PR leaves the queue because it was reviewed', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawReviewPr()]),
        fixtureOf([rawReviewPr({ reviewDecision: 'CHANGES_REQUESTED' })]),
      );
      expect(titles).toEqual([CHANGED_REVIEW]);
    });

    it('does NOT fire when a changeset-release PR is opened', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawReviewPr()]),
        fixtureOf([
          rawReviewPr(),
          rawReviewPr({ number: 9, headRefName: 'changeset-release/main' }),
        ]),
      );
      expect(titles).toEqual([]);
    });

    it('does NOT fire when a draft PR is opened', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawReviewPr()]),
        fixtureOf([rawReviewPr(), rawReviewPr({ number: 8, isDraft: true })]),
      );
      expect(titles).toEqual([]);
    });

    it('does NOT fire when an already-reviewed PR gains further activity', async () => {
      const reviewed = { reviewDecision: 'APPROVED' };
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawReviewPr(reviewed)]),
        fixtureOf([rawReviewPr({ ...reviewed, title: 'fix: thing (v2)' })]),
      );
      expect(titles).toEqual([]);
    });

    // PR #446 review, thread `discussion_r3617759355`: the test above only
    // covers a retitle on a PR that is ABSENT from the queue both before and
    // after (already reviewed). It cannot catch a title change churning a
    // still-actionable member, which is what json-diff would otherwise
    // re-fire on.
    it('does NOT fire when a still-undecided, in-queue PR is retitled', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawReviewPr()]),
        fixtureOf([rawReviewPr({ title: 'fix: thing (renamed)' })]),
      );
      expect(titles).toEqual([]);
    });

    /**
     * PR #446 review, thread `discussion_r3617759232`: `reviewDecision` is a
     * repository-wide, branch-protection-derived verdict. A repo requiring
     * two approvals can show `reviewDecision: 'APPROVED'` once ONE reviewer
     * approves, while a SECOND reviewer's request — this identity's own — is
     * still outstanding. Reducing membership to `reviewDecision` alone would
     * drop the PR from the queue while it still needs this viewer
     * specifically; `reviewRequests` is the per-viewer signal that keeps it
     * visible.
     */
    it('keeps a PR in the queue when reviewDecision reads APPROVED but this identity is still a requested reviewer', async () => {
      const result = await observe(
        scope,
        stub,
        fixtureOf([
          rawReviewPr({
            reviewDecision: 'APPROVED',
            reviewRequests: [{ login: 'octocat' }],
          }),
        ]),
      );
      const entries = JSON.parse(result.stdout) as { number: number }[];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.number).toBe(7);
    });

    it('drops a PR once reviewDecision reads APPROVED and this identity is no longer a requested reviewer', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([
          rawReviewPr({
            reviewDecision: 'REVIEW_REQUIRED',
            reviewRequests: [{ login: 'octocat' }],
          }),
        ]),
        fixtureOf([
          rawReviewPr({ reviewDecision: 'APPROVED', reviewRequests: [] }),
        ]),
      );
      expect(titles).toEqual([CHANGED_REVIEW]);
    });

    /**
     * PR #446 review, thread `discussion_r3624050268`: `reviewRequests` is a
     * union that includes `Team`/`EnterpriseTeam` requests, which expose a
     * team `slug`/`name` rather than a `login` — `gh` never expands a team
     * request out to individual member logins in this field. A plain
     * `.login == $me` check can therefore never match a team-requested PR,
     * so once `reviewDecision` reads `APPROVED` (a different reviewer
     * satisfying the policy) the PR must NOT be dropped while a team request
     * is still pending.
     */
    it('keeps a PR in the queue when reviewDecision reads APPROVED but a team review request is still pending', async () => {
      const result = await observe(
        scope,
        stub,
        fixtureOf([
          rawReviewPr({
            reviewDecision: 'APPROVED',
            reviewRequests: [{ slug: 'platform' }],
          }),
        ]),
      );
      const entries = JSON.parse(result.stdout) as { number: number }[];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.number).toBe(7);
    });

    /**
     * PR #446 review, thread `discussion_r3624450049`: the team-request
     * override above is only sound while `--search` itself already
     * establishes viewer relevance (the default `review-requested:@me`).
     * This scaffold also ships `label:needs-review` and an unscoped search as
     * supported alternatives (`PR_REVIEW_SCOPE_COMMENT`), and under either of
     * those the fetched `reviewRequests` can name a team the viewer isn't
     * even on. Simulates switching `search=` to the label-driven alternative
     * by editing the ONE variable assignment the scaffolded comment
     * instructs an author to change — the same edit a real user would make.
     */
    it('drops an APPROVED PR with only a team review request once the scope is no longer the default', async () => {
      const labelScopedScope = withSearchScope(scope, 'label:needs-review');
      const result = await observe(
        labelScopedScope,
        stub,
        fixtureOf([
          rawReviewPr({
            reviewDecision: 'APPROVED',
            reviewRequests: [{ slug: 'platform' }],
          }),
        ]),
      );
      expect(JSON.parse(result.stdout)).toEqual([]);
    });
  });
});

describe('json-diff semantics the presets rely on', () => {
  it('does NOT fire on key-order-only differences', async () => {
    const scope = presetScope('my-prs');
    const stub = stubGhEchoingFixture();
    const titles = await transition(
      scope,
      stub,
      '[{"number":101,"needs":"ci-failing","failingChecks":["build"]}]\n',
      '[{"failingChecks":["build"],"needs":"ci-failing","number":101}]\n',
    );
    expect(titles).toEqual([]);
  });

  it('does NOT fire when the actionable list is unchanged', async () => {
    const scope = presetScope('my-prs');
    const stub = stubGhEchoingFixture();
    const titles = await transition(
      scope,
      stub,
      fixtureOf([myPr()]),
      fixtureOf([myPr()]),
    );
    expect(titles).toEqual([]);
  });
});

describe('graceful degradation when gh is unusable (issue #444)', () => {
  /**
   * A `PATH` with no `gh` at all — only a `sh` symlink, so `sh -c` still
   * resolves. Constructing the directory rather than trimming the real `PATH`
   * keeps the test deterministic on machines and runners that ship `gh` in
   * `/usr/bin`.
   */
  function pathWithoutGh(): string {
    const dir = tempDir('nogh');
    symlinkSync('/bin/sh', path.join(dir, 'sh'));
    return dir;
  }

  /** A stub `gh` that fails the way an unauthenticated CLI does. */
  function stubGhUnauthenticated(): string {
    const dir = tempDir('stub-unauth');
    writeExecutable(
      path.join(dir, 'gh'),
      '#!/bin/sh\necho "gh: To get started with GitHub CLI, please run: gh auth login" >&2\nexit 4\n',
    );
    return dir;
  }

  async function observeRaw(
    scope: Scope,
    pathValue: string,
    previousState?: unknown,
  ): Promise<{
    observations: { title: string; payload?: Record<string, unknown> }[];
    state: unknown;
  }> {
    const result = await commandPoll.observe(
      { ...scope, env: { PATH: pathValue, AM444_FIXTURE: '/dev/null' } },
      {
        now: new Date('2026-01-15T10:00:00.000Z'),
        ...(previousState === undefined ? {} : { previousState }),
      },
    );
    return {
      observations: result.observations as {
        title: string;
        payload?: Record<string, unknown>;
      }[],
      state: result.nextState,
    };
  }

  it.each(['my-prs', 'pr-review'] as const)(
    '%s surfaces an actionable failure on the very first tick when gh is missing (never a silent baseline)',
    async (type) => {
      const scope = presetScope(type);
      const { observations } = await observeRaw(scope, pathWithoutGh());
      // 003 §11.5: a first-ever failing run emits the health observation
      // rather than establishing an empty baseline that never diffs again.
      expect(observations).toHaveLength(1);
      expect(observations[0]?.title).toBe(`Command failing: ${type}`);
      const stderrTail = String(observations[0]?.payload?.['stderrTail'] ?? '');
      expect(stderrTail).toContain('the GitHub CLI query failed');
      expect(stderrTail).toContain('https://cli.github.com');
      expect(stderrTail).toContain('gh auth login');
    },
  );

  /**
   * A `PATH` with a working `gh` stub and `sh`, but deliberately no `jq` —
   * neither the real system `jq` (excluded by never appending `/usr/bin:/bin`
   * the way {@link pathWith} does) nor a stubbed one. `--jq` is a second,
   * undeclared runtime dependency distinct from `gh` (PR #446 review, thread
   * `discussion_r3624050282`): before this fix, a jq-less host got a
   * `Command failing` remedy that named only `gh`, misleading an author who
   * already has `gh` installed and authenticated.
   */
  function pathWithGhButNoJq(): string {
    const dir = tempDir('nogh-jq');
    symlinkSync('/bin/sh', path.join(dir, 'sh'));
    writeExecutable(path.join(dir, 'gh'), '#!/bin/sh\necho "[]"\n');
    return dir;
  }

  it.each(['my-prs', 'pr-review'] as const)(
    '%s surfaces an actionable failure naming jq (not just gh) when jq is missing',
    async (type) => {
      const scope = presetScope(type);
      const { observations } = await observeRaw(scope, pathWithGhButNoJq());
      expect(observations).toHaveLength(1);
      expect(observations[0]?.title).toBe(`Command failing: ${type}`);
      const stderrTail = String(observations[0]?.payload?.['stderrTail'] ?? '');
      expect(stderrTail).toContain('jq');
      expect(stderrTail).toContain('https://jqlang.org');
    },
  );

  it('my-prs surfaces an actionable failure when gh is present but unauthenticated', async () => {
    const scope = presetScope('my-prs');
    const { observations } = await observeRaw(
      scope,
      pathWith(stubGhUnauthenticated()),
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]?.title).toBe('Command failing: my-prs');
    const stderrTail = String(observations[0]?.payload?.['stderrTail'] ?? '');
    // Both gh's own diagnosis and our remedy must survive to the event.
    expect(stderrTail).toContain('gh auth login');
    expect(stderrTail).toContain('PR alerting is NOT running');
  });

  it('does not re-alert while gh stays broken, then reports recovery', async () => {
    const scope = presetScope('my-prs');
    const broken = pathWith(stubGhUnauthenticated());
    const first = await observeRaw(scope, broken);
    expect(first.observations.map((o) => o.title)).toEqual([
      'Command failing: my-prs',
    ]);
    // 003 §11.5: the failing state is edge-triggered, so a persistently broken
    // gh must not interrupt on every tick.
    const second = await observeRaw(scope, broken, first.state);
    expect(second.observations).toEqual([]);

    const fixtureFile = path.join(tempDir('fixture'), 'fixture.json');
    writeFileSync(fixtureFile, fixtureOf([myPr()]), 'utf-8');
    const recovered = await commandPoll.observe(
      {
        ...scope,
        env: {
          PATH: pathWith(stubGhEchoingFixture()),
          AM444_FIXTURE: fixtureFile,
        },
      },
      {
        now: new Date('2026-01-15T10:10:00.000Z'),
        previousState: second.state,
      },
    );
    expect(recovered.observations.map((o) => o.title)).toEqual([
      'Command recovered: my-prs',
    ]);
  });
});

describe('gh environment/temp-file hardening (PR #446 review, thread 3)', () => {
  /**
   * A stub `gh` that fails loudly — reporting exactly which variable leaked —
   * if `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`,
   * `GITHUB_ENTERPRISE_TOKEN`, or `GH_REPO` reach it. A real `gh` would
   * instead silently honor whichever leaked, resolving `@me`/the repository
   * against the wrong identity with no error (issue #444 review, finding 2;
   * PR #446 review thread 3; `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN`
   * added per thread `discussion_r3624050247` — the GHES-host equivalent of
   * the same precedence rule).
   */
  function stubGhAssertingScrubbedEnv(): string {
    const dir = tempDir('stub-scrub-check');
    writeExecutable(
      path.join(dir, 'gh'),
      [
        '#!/bin/sh',
        'if [ -n "$GH_TOKEN" ] || [ -n "$GITHUB_TOKEN" ] || [ -n "$GH_ENTERPRISE_TOKEN" ] || [ -n "$GITHUB_ENTERPRISE_TOKEN" ] || [ -n "$GH_REPO" ]; then',
        '  echo "leaked: GH_TOKEN=$GH_TOKEN GITHUB_TOKEN=$GITHUB_TOKEN GH_ENTERPRISE_TOKEN=$GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN=$GITHUB_ENTERPRISE_TOKEN GH_REPO=$GH_REPO" >&2',
        '  exit 1',
        'fi',
        'cat "$AM444_FIXTURE"',
        '',
      ].join('\n'),
    );
    return dir;
  }

  it.each(['my-prs', 'pr-review'] as const)(
    '%s scrubs GH_TOKEN, GITHUB_TOKEN, GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN, and GH_REPO before invoking gh',
    async (type) => {
      const scope = presetScope(type);
      const fixtureFile = path.join(tempDir('fixture'), 'fixture.json');
      writeFileSync(fixtureFile, fixtureOf([]), 'utf-8');
      const result = await commandPoll.observe(
        {
          ...scope,
          env: {
            PATH: pathWith(stubGhAssertingScrubbedEnv()),
            AM444_FIXTURE: fixtureFile,
            GH_TOKEN: 'poison-gh-token',
            GITHUB_TOKEN: 'poison-github-token',
            GH_ENTERPRISE_TOKEN: 'poison-enterprise-token',
            GITHUB_ENTERPRISE_TOKEN: 'poison-github-enterprise-token',
            GH_REPO: 'someone-else/other-repo',
          },
        },
        { now: new Date('2026-01-15T10:00:00.000Z') },
      );
      // A first-ever run baselines silently either way; the assertion that
      // matters is that no leaked variable ever triggered the stub's failure
      // branch — if it had, this run would surface `Command failing: <type>`
      // instead of baselining quietly. Dropping any one of the five `unset`
      // targets in `ghPresetScript` reintroduces the leak this guards against.
      expect(result.observations).toEqual([]);
    },
  );

  /** A stub `gh` that fails the way an unauthenticated CLI does. */
  function stubGhFailing(): string {
    const dir = tempDir('stub-fail');
    writeExecutable(
      path.join(dir, 'gh'),
      '#!/bin/sh\necho "gh: To get started with GitHub CLI, please run: gh auth login" >&2\nexit 4\n',
    );
    return dir;
  }

  it('removes its per-invocation stderr temp file after both a successful and a failing run', async () => {
    const scope = presetScope('my-prs');
    const tmp = tempDir('mktemp-cleanup-check');

    const fixtureFile = path.join(tmp, 'fixture.json');
    writeFileSync(fixtureFile, fixtureOf([]), 'utf-8');
    await commandPoll.observe(
      {
        ...scope,
        env: {
          PATH: pathWith(stubGhEchoingFixture()),
          AM444_FIXTURE: fixtureFile,
          TMPDIR: tmp,
        },
      },
      { now: new Date('2026-01-15T10:00:00.000Z') },
    );

    await commandPoll.observe(
      {
        ...scope,
        env: {
          PATH: pathWith(stubGhFailing()),
          TMPDIR: tmp,
        },
      },
      { now: new Date('2026-01-15T10:05:00.000Z') },
    );

    const leftoverStderrFiles = readdirSync(tmp).filter(
      (name) => name.includes('agentmonitors-') && name.endsWith('.stderr'),
    );
    expect(leftoverStderrFiles).toEqual([]);
  });

  it('scaffolds the mktemp-based, trap-cleaned stderr file (not a predictable PID path)', () => {
    for (const type of ['pr-review', 'my-prs'] as const) {
      const template = TEMPLATES[type];
      expect(template).toBeDefined();
      expect(template).toContain('mktemp');
      expect(template).toContain('trap \'rm -f "$errfile"\' EXIT');
      // The pre-hardening implementation embedded the sh PID directly in the
      // filename (`agentmonitors-<preset>-$$.stderr`), a predictable path in
      // a shared /tmp. mktemp's own XXXXXX template replaces it.
      expect(template).not.toMatch(
        /errfile="\$\{TMPDIR:-\/tmp\}\/[^"]*-\$\$\.stderr"/,
      );
    }
  });

  /**
   * A stub `gh` that fails loudly — reporting the wrong host it was actually
   * called with — unless `gh api user`'s `--hostname` matches `expectedHost`.
   * A real `gh` would instead silently query `api.github.com`, either failing
   * outright on GHES or comparing a dotcom login against Enterprise PR
   * authors that can never match (PR #446 review, thread
   * `discussion_r3617759108`).
   */
  function stubGhAssertingHostname(
    expectedHost: string,
    repoUrl: string,
  ): string {
    const dir = tempDir('stub-hostname-check');
    writeExecutable(
      path.join(dir, 'gh'),
      [
        '#!/bin/sh',
        'if [ "$1" = "repo" ]; then',
        `  printf '%s\\n' '${repoUrl}'`,
        '  exit 0',
        'fi',
        'if [ "$1" = "api" ]; then',
        '  host=""',
        '  while [ $# -gt 0 ]; do',
        '    if [ "$1" = "--hostname" ]; then host="$2"; fi',
        '    shift',
        '  done',
        `  if [ "$host" != "${expectedHost}" ]; then`,
        `    echo "wrong host: got [$host], expected [${expectedHost}]" >&2`,
        '    exit 1',
        '  fi',
        '  printf \'{"login":"octocat"}\\n\'',
        '  exit 0',
        'fi',
        'cat "$AM444_FIXTURE"',
        '',
      ].join('\n'),
    );
    return dir;
  }

  it('resolves gh api user against the current repository’s own Enterprise host, not github.com', async () => {
    const scope = presetScope('pr-review');
    const fixtureFile = path.join(tempDir('fixture'), 'fixture.json');
    writeFileSync(fixtureFile, fixtureOf([]), 'utf-8');
    const result = await commandPoll.observe(
      {
        ...scope,
        env: {
          PATH: pathWith(
            stubGhAssertingHostname(
              'github.example.com',
              'https://github.example.com/acme/app',
            ),
          ),
          AM444_FIXTURE: fixtureFile,
        },
      },
      { now: new Date('2026-01-15T10:00:00.000Z') },
    );
    // A first-ever run baselines silently either way; the assertion that
    // matters is that the stub's wrong-host branch never fired — if it had,
    // this run would surface `Command failing: pr-review` instead of
    // baselining quietly.
    expect(result.observations).toEqual([]);
  });
});

describe('reviewer scoping (PR #446 review, thread 1)', () => {
  /** The scaffolded `watch.command` argv, joined for flag inspection. */
  function commandOf(type: 'pr-review' | 'my-prs'): string {
    return (presetScope(type)['command'] as string[]).join(' ');
  }

  /**
   * The defect: the reviewer preset returned every open, non-draft,
   * non-release PR — including the user's own and unrelated ones — despite
   * being defined as *the current reviewer's* queue. Draft/release filtering
   * lives in the `--jq`, so only an argv-level assertion catches its absence.
   *
   * The scope now flows through a `search=` shell variable (read by both
   * `--search "$search"` and the `--jq`'s scope-conditional team-request
   * clause — see `discussion_r3624450049`) rather than being inlined
   * directly into `--search`, so this asserts against the variable
   * assignment, not the flag's own argument text.
   */
  it('scopes the reviewer queue to a reviewer, not to every open PR', () => {
    const command = commandOf('pr-review');
    expect(command).toContain('--search "$search"');
    // One of the documented reviewer-scoping qualifiers must be present; a
    // bare `search=''` or a missing assignment is exactly the unscoped defect.
    expect(command).toMatch(
      /search='?(review-requested:@me|-author:@me|label:[\w-]+)/,
    );
  });

  it('defaults to explicit review requests', () => {
    expect(commandOf('pr-review')).toContain("search='review-requested:@me'");
  });

  /**
   * Reviewer scoping is workflow-dependent: `review-requested:@me` matches
   * nothing for a solo maintainer, or when PRs are authored and reviewed under
   * one identity (GitHub does not allow requesting review from yourself).
   * Measured against this repository: unscoped returns 6 open PRs,
   * `review-requested:@me` returns 0. An author in any of those workflows must
   * be able to fix it by editing one string, so the alternatives ship in the
   * scaffold rather than living only in the docs.
   */
  it('scaffolds the alternative scoping models as ready-to-edit comments', () => {
    const template = TEMPLATES['pr-review'] ?? '';
    expect(template).toContain('-author:@me');
    expect(template).toContain('label:needs-review');
    expect(template).toContain('REVIEWER SCOPING');
  });

  /**
   * An empty scoped result is indistinguishable from "nothing needs review",
   * so the scaffold must say so rather than degrading silently.
   */
  it('warns in the monitor body that an empty queue may mean mis-scoping', () => {
    const template = TEMPLATES['pr-review'] ?? '';
    expect(template).toContain('If this monitor never fires');
    expect(template).toContain(
      'gh pr list --state open --search "review-requested:@me"',
    );
  });

  /**
   * PR #446 review, thread `discussion_r3615190027`: `--search` alone does
   * NOT guarantee `pr-review`/`my-prs` disjointness (label-driven and
   * unscoped both fail to exclude the current identity's own PRs). The fix
   * resolves the current `gh` identity once per tick, unconditionally,
   * regardless of which `--search` qualifier is scaffolded or later edited
   * — this argv-level assertion is what would catch a regression that
   * dropped that call while leaving the rest of the shipped `--search`
   * argument untouched (the jq-level exclusion itself is exercised in "the
   * two presets do not overlap" above).
   */
  it('always resolves the current identity, independent of the --search scope', () => {
    expect(commandOf('pr-review')).toContain(
      'gh api user --hostname "$host" --jq \'{login}\'',
    );
  });

  /**
   * PR #446 review, thread `discussion_r3617759108`: `gh api user` (a bare,
   * repo-less endpoint) does not auto-detect a host the way `gh pr list`'s
   * own repository resolution does — it defaults to `github.com` even inside
   * a GitHub Enterprise checkout. The fetch must resolve `gh api user`'s host
   * from the SAME repository `gh pr list` targets (via `gh repo view`, which
   * does resolve host from the working directory) rather than hardcoding
   * `github.com` or omitting `--hostname` entirely.
   */
  it('resolves the identity-lookup host from the current repository, not a hardcoded github.com', () => {
    const command = commandOf('pr-review');
    expect(command).toContain('gh repo view');
    expect(command).toContain('--hostname "$host"');
    expect(command).not.toMatch(/--hostname\s+github\.com/);
  });
});

describe('delivered alert readability (issue #449 guard)', () => {
  /**
   * `command-poll` titles its observation `Command output changed: <objectKey>`,
   * and `objectKey` defaults to the **joined argv** — which for these presets
   * would put the entire `gh` command and `--jq` program in the alert headline.
   * Both presets therefore set an explicit `key:`. Making the title use the
   * monitor's authored `name` instead is issue #449 (a source-level change
   * affecting every command-poll monitor); this guard only keeps the presets
   * from regressing to the raw-argv title.
   */
  /**
   * One raw `gh pr list --json ...` entry per preset that its real `--jq`
   * reduction (now a separate `jq -sc` stage, not a `gh --jq` flag) classes
   * as actionable — `stubGhEchoingFixture` hands this straight to `gh`, and
   * the shipped script's own `jq` reduces it for real, so this exercises the
   * same pipeline production traffic does, not a pre-reduced shortcut.
   */
  const RAW_ACTIONABLE_FIXTURE: Record<'my-prs' | 'pr-review', unknown[]> = {
    'my-prs': [
      {
        number: 1,
        title: 'feat: add widget',
        url: 'https://github.com/acme/app/pull/1',
        state: 'OPEN',
        isDraft: false,
        reviewDecision: '',
        statusCheckRollup: [
          {
            __typename: 'CheckRun',
            name: 'build',
            status: 'COMPLETED',
            conclusion: 'FAILURE',
          },
        ],
        latestReviews: [],
        comments: [],
        mergedAt: null,
        closedAt: null,
        author: { login: 'octocat' },
      },
    ],
    'pr-review': [
      {
        number: 1,
        title: 'fix: thing',
        isDraft: false,
        reviewDecision: '',
        headRefName: 'fix/thing',
        // Distinct from stubGhEchoingFixture's default identity ('octocat',
        // matching 'my-prs' above): a pr-review fixture authored by the
        // current identity would now be excluded (PR #446 review, thread
        // r3615190027), which is not what this readability-only test is
        // about.
        author: { login: 'contributor' },
        statusCheckRollup: [],
      },
    ],
  };

  it.each(['my-prs', 'pr-review'] as const)(
    '%s titles its event with a short key, never the raw command',
    async (type) => {
      const scope = presetScope(type);
      const stub = stubGhEchoingFixture();
      const baseline = await observe(scope, stub, fixtureOf([]));
      const changed = await observe(
        scope,
        stub,
        fixtureOf(RAW_ACTIONABLE_FIXTURE[type]),
        baseline.state,
      );
      expect(changed.titles).toEqual([`Command output changed: ${type}`]);
      const title = changed.titles[0] ?? '';
      expect(title).not.toContain('gh pr list');
      expect(title).not.toContain('--jq');
      expect(title).not.toContain('[.[]');
      expect(title.length).toBeLessThan(60);
    },
  );
});

describe('preset portability guarantees (issue #444)', () => {
  /** The scaffolded `watch.command` argv, joined for flag inspection. */
  function commandOf(type: 'pr-review' | 'my-prs'): string {
    return (presetScope(type)['command'] as string[]).join(' ');
  }

  it.each(['my-prs', 'pr-review'] as const)(
    '%s hardcodes neither a repository nor a username',
    (type) => {
      // Asserted against the executed argv, not the template prose — the
      // templates' comments legitimately mention `--repo` to explain why it is
      // absent, and a prose match would pass even if the flag came back.
      const command = commandOf(type);
      // A --repo flag would pin the monitor to one repository; gh must infer
      // it from the daemon's working directory instead.
      expect(command).not.toContain('--repo ');
      // --author must stay the gh-identity placeholder, never a login.
      expect(command).not.toMatch(/--author\s+(?!@me)/);
    },
  );

  it('my-prs queries the current gh user via @me', () => {
    expect(commandOf('my-prs')).toContain('--author @me');
  });

  it.each(['my-prs', 'pr-review'] as const)(
    '%s scaffolds a monitor that parses and declares command-poll',
    (type) => {
      const scope = presetScope(type);
      expect(scope['key']).toBe(type);
      expect(scope['change-detection']).toEqual({ strategy: 'json-diff' });
    },
  );

  // Neither preset is `high`, and for my-prs that is a deliberate reversal of
  // the intuitive call. json-diff is symmetric, so benign transitions (CI
  // recovering, a PR merging, your own new PR appearing) fire exactly like
  // actionable ones; `high` would therefore interrupt mid-turn on good news —
  // the interrupt-storm anti-pattern (#441). See 002 §9 and 003 §11.9.
  it('both presets are high urgency', () => {
    expect(TEMPLATES['my-prs'] ?? '').toMatch(/^urgency: high$/m);
    expect(TEMPLATES['pr-review'] ?? '').toMatch(/^urgency: high$/m);
  });
});
