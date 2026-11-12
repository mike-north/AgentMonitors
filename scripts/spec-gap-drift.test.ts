/**
 * Guard: the roadmap must not call a test gap closed while its governing numbered
 * spec still carries the open marker for it (spec 004 §3.0, §5).
 *
 * The first block runs the check against the real docs. The second proves the check
 * can fail, using inline fixtures that each reintroduce one kind of drift.
 *
 * @see ../docs/specs/004-validation-testing.md
 * @see ../docs/specs/roadmap.md
 */
import { describe, expect, it } from 'vitest';
import {
  checkSpecGapDrift,
  findClosedRoadmapGaps,
  findGapMarkers,
  loadRepoSpecs,
  repoPathExists,
} from './lib/spec-gap-drift.mjs';

const ROADMAP = [
  '## Test gaps',
  '',
  '- **T1** — closed gap.',
  '- **T2** (open) — still open.',
  '',
  '## How to retire an item',
  '- **T9** — outside the section.',
].join('\n');

const exists = () => true;

describe('spec gap drift (real docs)', () => {
  it('has no roadmap-closed gap whose spec marker remains, no unnumbered marker, and no dangling cited test file', () => {
    const { specs, roadmapText } = loadRepoSpecs();
    expect(
      checkSpecGapDrift({ specs, roadmapText, pathExists: repoPathExists }),
    ).toEqual([]);
  });

  it('reads the roadmap closed list', () => {
    expect(findClosedRoadmapGaps(loadRepoSpecs().roadmapText)).toEqual(
      expect.arrayContaining(['T1', 'T2', 'T3', 'T4']),
    );
  });
});

describe('spec gap drift (fixtures)', () => {
  it('fails when a spec still carries the marker for a gap the roadmap closed', () => {
    const problems = checkSpecGapDrift({
      specs: { '004-x.md': 'row | **TEST GAP T1** — missing' },
      roadmapText: ROADMAP,
      pathExists: exists,
    });
    expect(problems).toEqual([
      '004-x.md:1 carries open gap marker T1 but roadmap.md lists T1 as closed',
    ]);
  });

  it('fails for a partial-gap marker too', () => {
    const problems = checkSpecGapDrift({
      specs: { '004-x.md': 'a\n**PARTIAL GAP T1** — half' },
      roadmapText: ROADMAP,
      pathExists: exists,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('004-x.md:2');
  });

  it('accepts a marker for a gap the roadmap keeps open', () => {
    expect(
      checkSpecGapDrift({
        specs: { '004-x.md': '**TEST GAP T2** — still genuine' },
        roadmapText: ROADMAP,
        pathExists: exists,
      }),
    ).toEqual([]);
  });

  it('fails on a marker without a tracked id', () => {
    const problems = checkSpecGapDrift({
      specs: { '004-x.md': '**TEST GAP** — untracked' },
      roadmapText: ROADMAP,
      pathExists: exists,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no tracked id');
  });

  it('ignores bullets outside the Test gaps section', () => {
    expect(findClosedRoadmapGaps(ROADMAP)).toEqual(['T1']);
  });

  it('fails when a spec cites a test file that does not exist', () => {
    const problems = checkSpecGapDrift({
      specs: { '004-x.md': 'Covered (`libs/core/src/nope.test.ts` — "x")' },
      roadmapText: ROADMAP,
      pathExists: () => false,
    });
    expect(problems).toEqual([
      '004-x.md cites test file libs/core/src/nope.test.ts, which does not exist',
    ]);
  });

  it('does not treat prose naming the marker convention as a marker', () => {
    expect(findGapMarkers('use `TEST GAP T<n>` in a spec')).toEqual([]);
  });
});
