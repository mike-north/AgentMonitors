/**
 * Proof tests for the deterministic Shape stage's derived-facts and render
 * primitives (roadmap G15).
 *
 * Expected values are written BY HAND from the spec — no snapshot / gold-master
 * assertions (explicit repo policy). Every assertion traces to a spec rule.
 *
 * @see ../../../../docs/specs/001-monitor-definition.md §5.1 (Shape declaration)
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.4 (derived facts)
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.5 (render-then-diff)
 */
import { describe, expect, it } from 'vitest';
import {
  computeDerivedFacts,
  renderArtifact,
  validateCelPredicate,
  type DerivedFactRule,
} from './shape.js';
import { renderShapeArtifact, buildTextDiff } from './diff.js';

// Fixed, deterministic clock constants (never `Date.now()`/`new Date()` for the
// time input). Epoch milliseconds, so CEL number comparisons are exact.
// 2024-01-15T10:00:00.000Z and one minute earlier.
const NOW = Date.parse('2024-01-15T10:00:00.000Z');
const ONE_MINUTE = 60_000;
const NOW_MINUS_1MIN = NOW - ONE_MINUTE;

// A single deferred task whose defer-until threshold is exactly `NOW`: at `NOW`
// it is `revealed` (`defer-until <= now`); one minute earlier it is not.
// 002 §1.1.4: `revealed` when a previously-deferred item has `defer-until <= now`.
const deferUntilNow = { task: 'Ship deck', deferUntil: NOW };

// 001 §5.1: `derive` is an ordered list of { name, when } where `when` is a CEL
// boolean predicate over (snapshot, now).
const revealedRule: DerivedFactRule = {
  name: 'revealed',
  when: 'deferUntil <= now',
};

describe('Shape — derived facts (002 §1.1.4)', () => {
  describe('fixed-`now` purity (threshold crossing)', () => {
    it('yields exactly `revealed` when the defer threshold is crossed', () => {
      // At NOW, deferUntil (== NOW) <= now → the rule holds, and ONLY that fact.
      const facts = computeDerivedFacts(deferUntilNow, NOW, [revealedRule]);
      expect(facts).toEqual([{ name: 'revealed' }]);
    });

    it('yields no facts one minute earlier (proving purity over (snapshot, now))', () => {
      // One minute earlier, deferUntil (NOW) > now → the rule does not hold.
      const facts = computeDerivedFacts(deferUntilNow, NOW_MINUS_1MIN, [
        revealedRule,
      ]);
      expect(facts).toEqual([]);
    });

    it('is reproducible — same (snapshot, now) yields the same facts', () => {
      const a = computeDerivedFacts(deferUntilNow, NOW, [revealedRule]);
      const b = computeDerivedFacts(deferUntilNow, NOW, [revealedRule]);
      expect(a).toEqual(b);
    });
  });

  describe('the four E8 rule shapes (002 §1.1.4 table)', () => {
    // priority high, due 12h out, defer crossed → urgent + due-soon + revealed.
    const HOUR = 3_600_000;
    const task = {
      priority: 'high',
      due: NOW + 12 * HOUR,
      deferUntil: NOW - HOUR,
    };
    const rules: DerivedFactRule[] = [
      { name: 'past-due', when: 'due < now' },
      { name: 'due-soon', when: 'now <= due && due <= now + 172800000' }, // now+48h
      { name: 'revealed', when: 'deferUntil <= now' },
      { name: 'urgent', when: "priority == 'high' && due <= now + 86400000" }, // now+24h
    ];

    it('computes facts in authored order, only those that hold', () => {
      // due is in the future (not past-due); within 48h (due-soon) and within
      // 24h with high priority (urgent); defer crossed (revealed).
      const facts = computeDerivedFacts(task, NOW, rules);
      expect(facts).toEqual([
        { name: 'due-soon' },
        { name: 'revealed' },
        { name: 'urgent' },
      ]);
    });

    it('treats a predicate over an absent field as not-held (no crash)', () => {
      // The snapshot has no `due`; the rule must not throw, the fact is absent.
      const facts = computeDerivedFacts({ priority: 'low' }, NOW, [
        { name: 'past-due', when: 'due < now' },
      ]);
      expect(facts).toEqual([]);
    });
  });
});

describe('Shape — render-then-diff (002 §1.1.5)', () => {
  const rules: DerivedFactRule[] = [
    { name: 'revealed', when: 'deferUntil <= now' },
  ];

  it('renders the same shaped state to byte-identical text (no phantom diff)', () => {
    const a = renderShapeArtifact(deferUntilNow, NOW, rules);
    const b = renderShapeArtifact(deferUntilNow, NOW, rules);
    expect(a).toBe(b);
    // Byte-stable ⇒ diffing the artifact against itself yields no delta.
    expect(buildTextDiff(a, b)).toBe('');
  });

  it('is byte-stable regardless of source key ordering', () => {
    // 002 §1.1.5: stable field ordering, no incidental churn. Reordering the
    // snapshot's keys must not change the rendered artifact.
    const reordered = { deferUntil: NOW, task: 'Ship deck' };
    expect(renderShapeArtifact(reordered, NOW, rules)).toBe(
      renderShapeArtifact(deferUntilNow, NOW, rules),
    );
  });

  it('one crossed threshold yields exactly one added `revealed` line', () => {
    // Before: one minute earlier, the fact does not hold → no `revealed` line.
    // After: at NOW the threshold is crossed → the artifact gains one line.
    const before = renderShapeArtifact(deferUntilNow, NOW_MINUS_1MIN, rules);
    const after = renderShapeArtifact(deferUntilNow, NOW, rules);

    // The only difference is the appended fact line; the snapshot section is
    // byte-identical at both clocks (the raw facts did not change).
    const diff = buildTextDiff(before, after);
    const addedLines = diff.split('\n').filter((line) => line.startsWith('+'));
    expect(addedLines).toHaveLength(1);
    expect(addedLines[0]).toContain('- revealed');
    // And no lines were removed (a pure addition).
    expect(diff.split('\n').filter((l) => l.startsWith('-'))).toHaveLength(0);
  });

  it('surfaces the held fact under the `# facts` section', () => {
    const artifact = renderArtifact(deferUntilNow, [{ name: 'revealed' }]);
    expect(artifact).toContain('# facts');
    expect(artifact).toContain('- revealed');
  });
});

describe('Shape — CEL predicate validation (004 §2.2)', () => {
  it('accepts a well-formed predicate', () => {
    expect(validateCelPredicate('deferUntil <= now')).toBeUndefined();
  });

  it('rejects a malformed predicate', () => {
    expect(validateCelPredicate('deferUntil <=')).toBeDefined();
  });
});
