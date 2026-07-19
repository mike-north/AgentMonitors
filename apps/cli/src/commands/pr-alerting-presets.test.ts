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
 */
function stubGhEchoingFixture(): string {
  const dir = tempDir('stub');
  writeExecutable(path.join(dir, 'gh'), '#!/bin/sh\ncat "$AM444_FIXTURE"\n');
  return dir;
}

/**
 * A `PATH` directory holding a stub `gh` that reads `$AM444_FIXTURE` as **raw**
 * `gh pr list --json` output and pipes it through the preset's own `--jq`
 * program using the real `jq` binary. This is what proves the shipped jq
 * reduction actually maps GitHub's payload onto the diffed shape.
 */
function stubGhApplyingJq(): string {
  const dir = tempDir('stub-jq');
  writeExecutable(
    path.join(dir, 'gh'),
    // Walk argv for `--jq <program>`; everything else is ignored.
    [
      '#!/bin/sh',
      'prog=""',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "--jq" ]; then prog="$2"; fi',
      '  shift',
      'done',
      'jq -c "$prog" < "$AM444_FIXTURE"',
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

  /** A raw `gh pr list --json ...` element for the `pr-review` preset. */
  function rawReviewPr(overrides: Record<string, unknown> = {}): unknown {
    return {
      number: 7,
      title: 'fix: thing',
      isDraft: false,
      reviewDecision: '',
      headRefName: 'fix/thing',
      author: { id: 'MDQ6', is_bot: false, login: 'octocat', name: 'Octo Cat' },
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
      ...overrides,
    };
  }

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
          title: 'feat: add widget',
          url: 'https://github.com/acme/app/pull/101',
          needs: 'ci-failing',
          failingChecks: ['build'],
          reviews: [],
          commentCount: 0,
        },
      ]);
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

    it('fires when state becomes MERGED', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(QUIET)]),
        fixtureOf([rawMyPr({ ...QUIET, state: 'MERGED' })]),
      );
      expect(titles).toEqual([CHANGED]);
    });

    it('fires when state becomes CLOSED', async () => {
      const titles = await transition(
        scope,
        stub,
        fixtureOf([rawMyPr(QUIET)]),
        fixtureOf([rawMyPr({ ...QUIET, state: 'CLOSED' })]),
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
        fixtureOf([rawMyPr({ ...QUIET, state: 'MERGED' })]),
      );
      expect(JSON.parse(merged.stdout)).toEqual([
        {
          number: 101,
          title: 'feat: add widget',
          url: 'https://github.com/acme/app/pull/101',
          needs: 'merged',
        },
      ]);
      const closed = await observe(
        scope,
        stub,
        fixtureOf([rawMyPr({ ...QUIET, state: 'CLOSED' })]),
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
      const merged = { ...QUIET, state: 'MERGED' };
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
          title: 'fix: thing',
          headRefName: 'fix/thing',
          author: 'octocat',
        },
      ]);
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
