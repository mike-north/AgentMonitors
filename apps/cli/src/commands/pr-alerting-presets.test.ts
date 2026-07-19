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
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseMonitor } from '@agentmonitors/core';
import commandPoll from '@agentmonitors/source-command-poll';
import { beforeAll, describe, expect, it } from 'vitest';
import { TEMPLATES } from './init.js';

/** Where the scaffolded template's `watch:` block lands after parsing. */
type Scope = Record<string, unknown>;

/**
 * Parse a preset template exactly as `init` scaffolds it and hand back the
 * `watch:` config with `type` stripped — the shape the source receives.
 * Failing here means the shipped template no longer parses, which is the same
 * failure `agentmonitors validate` would report.
 */
function presetScope(type: 'pr-review' | 'my-prs'): Scope {
  const template = TEMPLATES[type];
  if (template === undefined) throw new Error(`no template for ${type}`);
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), 'am444-parse-')),
    'MONITOR.md',
  );
  writeFileSync(file, template, 'utf-8');
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
  return mkdtempSync(path.join(tmpdir(), `am444-${prefix}-`));
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

/** One entry in `my-prs`'s reduced, diffed shape. */
interface MyPrEntry {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  reviewDecision: string;
  failingChecks: string[];
  reviews: { by: string; state: string }[];
  commentCount: number;
}

/** A healthy, open, green, unreviewed PR — the "nothing to report" baseline. */
function myPr(overrides: Partial<MyPrEntry> = {}): MyPrEntry {
  return {
    number: 101,
    title: 'feat: add widget',
    url: 'https://github.com/acme/app/pull/101',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: '',
    failingChecks: [],
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

describe('`--type my-prs` fires on every trigger class (issue #444)', () => {
  let scope: Scope;
  let stub: string;
  beforeAll(() => {
    scope = presetScope('my-prs');
    stub = stubGhEchoingFixture();
  });

  it('fires when CI goes green -> red', async () => {
    const titles = await transition(
      scope,
      stub,
      fixtureOf([myPr({ failingChecks: [] })]),
      fixtureOf([myPr({ failingChecks: ['build'] })]),
    );
    expect(titles).toEqual([CHANGED]);
  });

  it('fires when CI recovers red -> green', async () => {
    const titles = await transition(
      scope,
      stub,
      fixtureOf([myPr({ failingChecks: ['build'] })]),
      fixtureOf([myPr({ failingChecks: [] })]),
    );
    expect(titles).toEqual([CHANGED]);
  });

  it('fires when reviewDecision becomes CHANGES_REQUESTED', async () => {
    const titles = await transition(
      scope,
      stub,
      fixtureOf([myPr({ reviewDecision: '' })]),
      fixtureOf([myPr({ reviewDecision: 'CHANGES_REQUESTED' })]),
    );
    expect(titles).toEqual([CHANGED]);
  });

  it('fires when a new review lands without changing reviewDecision', async () => {
    const titles = await transition(
      scope,
      stub,
      fixtureOf([myPr({ reviews: [] })]),
      fixtureOf([myPr({ reviews: [{ by: 'octocat', state: 'COMMENTED' }] })]),
    );
    expect(titles).toEqual([CHANGED]);
  });

  it('fires when a new comment lands', async () => {
    const titles = await transition(
      scope,
      stub,
      fixtureOf([myPr({ commentCount: 0 })]),
      fixtureOf([myPr({ commentCount: 1 })]),
    );
    expect(titles).toEqual([CHANGED]);
  });

  it('fires when isDraft goes true -> false (marked ready)', async () => {
    const titles = await transition(
      scope,
      stub,
      fixtureOf([myPr({ isDraft: true })]),
      fixtureOf([myPr({ isDraft: false })]),
    );
    expect(titles).toEqual([CHANGED]);
  });

  it('fires when isDraft goes false -> true (pulled back to draft)', async () => {
    const titles = await transition(
      scope,
      stub,
      fixtureOf([myPr({ isDraft: false })]),
      fixtureOf([myPr({ isDraft: true })]),
    );
    expect(titles).toEqual([CHANGED]);
  });

  it('fires when state becomes MERGED', async () => {
    const titles = await transition(
      scope,
      stub,
      fixtureOf([myPr({ state: 'OPEN' })]),
      fixtureOf([myPr({ state: 'MERGED' })]),
    );
    expect(titles).toEqual([CHANGED]);
  });

  it('fires when state becomes CLOSED', async () => {
    const titles = await transition(
      scope,
      stub,
      fixtureOf([myPr({ state: 'OPEN' })]),
      fixtureOf([myPr({ state: 'CLOSED' })]),
    );
    expect(titles).toEqual([CHANGED]);
  });

  it('fires when a newly authored PR appears', async () => {
    const titles = await transition(
      scope,
      stub,
      fixtureOf([myPr({ number: 101 })]),
      fixtureOf([myPr({ number: 101 }), myPr({ number: 102 })]),
    );
    expect(titles).toEqual([CHANGED]);
  });

  // Control: without this, every assertion above would pass even if the
  // monitor fired unconditionally on each tick.
  it('does NOT fire when nothing changed', async () => {
    const titles = await transition(
      scope,
      stub,
      fixtureOf([myPr()]),
      fixtureOf([myPr()]),
    );
    expect(titles).toEqual([]);
  });

  // json-diff compares semantically (003 §11.3), so a re-serialization with
  // different key order must not manufacture an interrupt.
  it('does NOT fire on key-order-only differences', async () => {
    const before = '[{"number":101,"state":"OPEN","failingChecks":[]}]\n';
    const after = '[{"failingChecks":[],"state":"OPEN","number":101}]\n';
    const titles = await transition(scope, stub, before, after);
    expect(titles).toEqual([]);
  });
});

describe('`--type pr-review` reviewer queue (issue #444)', () => {
  let scope: Scope;
  let stub: string;
  beforeAll(() => {
    scope = presetScope('pr-review');
    stub = stubGhEchoingFixture();
  });

  it('fires when a non-draft PR appears in the queue', async () => {
    const titles = await transition(
      scope,
      stub,
      fixtureOf([]),
      fixtureOf([
        {
          number: 7,
          title: 'fix: thing',
          headRefName: 'fix/thing',
          reviewDecision: '',
          author: 'octocat',
        },
      ]),
    );
    expect(titles).toEqual([CHANGED_REVIEW]);
  });

  it('fires when reviewDecision flips', async () => {
    const base = {
      number: 7,
      title: 'fix: thing',
      headRefName: 'fix/thing',
      author: 'octocat',
    };
    const titles = await transition(
      scope,
      stub,
      fixtureOf([{ ...base, reviewDecision: '' }]),
      fixtureOf([{ ...base, reviewDecision: 'CHANGES_REQUESTED' }]),
    );
    expect(titles).toEqual([CHANGED_REVIEW]);
  });
});

/**
 * The shipped `--jq` reduction, run for real. `jq` is preinstalled on the
 * `ubuntu-latest` runner every CI job uses, so this coverage is never skipped
 * in CI; the guard only spares a contributor whose machine lacks `jq`.
 */
const hasJq = (() => {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasJq)('the presets’ jq reduction over raw gh output', () => {
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

  it('excludes a changeset-release/* head from the reviewer queue', async () => {
    const scope = presetScope('pr-review');
    const stub = stubGhApplyingJq();
    const result = await observe(
      scope,
      stub,
      fixtureOf([
        rawReviewPr({ number: 9, headRefName: 'changeset-release/main' }),
      ]),
    );
    // The release PR is the only candidate, so a correct filter yields [].
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it('excludes drafts and keeps real PRs, projecting author to a login', async () => {
    const scope = presetScope('pr-review');
    const stub = stubGhApplyingJq();
    const result = await observe(
      scope,
      stub,
      fixtureOf([
        rawReviewPr({ number: 8, isDraft: true }),
        rawReviewPr({ number: 7 }),
        rawReviewPr({ number: 9, headRefName: 'changeset-release/main' }),
      ]),
    );
    expect(JSON.parse(result.stdout)).toEqual([
      {
        number: 7,
        title: 'fix: thing',
        headRefName: 'fix/thing',
        reviewDecision: '',
        author: 'octocat',
      },
    ]);
  });

  it('does NOT fire when a changeset-release PR is opened', async () => {
    const scope = presetScope('pr-review');
    const stub = stubGhApplyingJq();
    const titles = await transition(
      scope,
      stub,
      fixtureOf([rawReviewPr({ number: 7 })]),
      fixtureOf([
        rawReviewPr({ number: 7 }),
        rawReviewPr({ number: 9, headRefName: 'changeset-release/main' }),
      ]),
    );
    expect(titles).toEqual([]);
  });

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

  it('reduces a failed CheckRun into failingChecks, and a green one into []', async () => {
    const scope = presetScope('my-prs');
    const stub = stubGhApplyingJq();
    const green = await observe(
      scope,
      stub,
      fixtureOf([
        rawMyPr({ statusCheckRollup: [checkRun('build', 'SUCCESS')] }),
      ]),
    );
    expect(
      (JSON.parse(green.stdout) as { failingChecks: string[] }[])[0]
        ?.failingChecks,
    ).toEqual([]);

    const red = await observe(
      scope,
      stub,
      fixtureOf([
        rawMyPr({
          statusCheckRollup: [
            checkRun('build', 'FAILURE'),
            checkRun('lint', 'SUCCESS'),
          ],
        }),
      ]),
    );
    expect(
      (JSON.parse(red.stdout) as { failingChecks: string[] }[])[0]
        ?.failingChecks,
    ).toEqual(['build']);
  });

  it('treats a legacy StatusContext FAILURE state as a failing check', async () => {
    const scope = presetScope('my-prs');
    const stub = stubGhApplyingJq();
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

  it('fires on a real green -> red statusCheckRollup transition', async () => {
    const scope = presetScope('my-prs');
    const stub = stubGhApplyingJq();
    const titles = await transition(
      scope,
      stub,
      fixtureOf([
        rawMyPr({ statusCheckRollup: [checkRun('build', 'SUCCESS')] }),
      ]),
      fixtureOf([
        rawMyPr({ statusCheckRollup: [checkRun('build', 'FAILURE')] }),
      ]),
    );
    expect(titles).toEqual([CHANGED]);
  });

  // The reduction exists precisely so an in-flight CI run does not interrupt
  // once per check, per push (that is why `high` urgency is tolerable here).
  it('does NOT fire while checks are merely queued/in-progress', async () => {
    const scope = presetScope('my-prs');
    const stub = stubGhApplyingJq();
    const titles = await transition(
      scope,
      stub,
      fixtureOf([
        rawMyPr({
          statusCheckRollup: [
            {
              __typename: 'CheckRun',
              name: 'build',
              status: 'QUEUED',
              conclusion: '',
            },
          ],
        }),
      ]),
      fixtureOf([
        rawMyPr({
          statusCheckRollup: [
            {
              __typename: 'CheckRun',
              name: 'build',
              status: 'IN_PROGRESS',
              conclusion: '',
              startedAt: '2026-01-15T09:02:00Z',
            },
          ],
        }),
      ]),
    );
    expect(titles).toEqual([]);
  });

  // The design alternative considered here was collapsing statusCheckRollup to
  // a single PASSING/PENDING/FAILING verdict. That is quieter than diffing the
  // rollup raw, but it reintroduces the churn one level up: an ordinary push
  // that never breaks CI still walks PASSING -> PENDING -> PASSING and would
  // fire twice. Reducing to failing check NAMES stays silent across the whole
  // cycle, which is what this asserts — and is why a single-verdict collapse
  // was rejected rather than adopted.
  it('stays completely silent across a full push -> CI -> green cycle', async () => {
    const scope = presetScope('my-prs');
    const stub = stubGhApplyingJq();
    const cycle = [
      // Steady state: last run finished green.
      [checkRun('build', 'SUCCESS')],
      // Push lands: checks re-queued.
      [
        {
          __typename: 'CheckRun',
          name: 'build',
          status: 'QUEUED',
          conclusion: '',
        },
      ],
      // Checks running.
      [
        {
          __typename: 'CheckRun',
          name: 'build',
          status: 'IN_PROGRESS',
          conclusion: '',
          startedAt: '2026-01-15T09:02:00Z',
        },
      ],
      // Green again — same verdict as the start, never actionable.
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

  it('reduces review feedback to reviewer/state pairs and a comment count', async () => {
    const scope = presetScope('my-prs');
    const stub = stubGhApplyingJq();
    const result = await observe(
      scope,
      stub,
      fixtureOf([
        rawMyPr({
          reviewDecision: 'CHANGES_REQUESTED',
          latestReviews: [
            {
              author: { login: 'octocat' },
              state: 'CHANGES_REQUESTED',
              body: 'a very long review body that must not be diffed',
              submittedAt: '2026-01-15T09:30:00Z',
            },
          ],
          comments: [{ body: 'one' }, { body: 'two' }],
        }),
      ]),
    );
    expect(JSON.parse(result.stdout)).toEqual([
      {
        number: 101,
        title: 'feat: add widget',
        url: 'https://github.com/acme/app/pull/101',
        state: 'OPEN',
        isDraft: false,
        reviewDecision: 'CHANGES_REQUESTED',
        failingChecks: [],
        reviews: [{ by: 'octocat', state: 'CHANGES_REQUESTED' }],
        commentCount: 2,
      },
    ]);
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
  it('neither preset is high urgency', () => {
    expect(TEMPLATES['my-prs'] ?? '').toMatch(/^urgency: normal$/m);
    expect(TEMPLATES['pr-review'] ?? '').toMatch(/^urgency: normal$/m);
  });
});
