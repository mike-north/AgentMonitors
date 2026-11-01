/**
 * Proof tests for the author-declared payload-form transform (spec: pipeline/post-processing).
 *
 * Expected values are written BY HAND from the spec — no snapshot / gold-master
 * assertions (explicit repo policy).
 *
 * The two languages have distinct, non-overlapping roles (spec: pipeline/post-processing):
 * **`jq` reshapes** (its output is the structured payload) and **`cel` gates**
 * (a boolean: `true` delivers the un-reshaped snapshot, `false` suppresses).
 *
 * @see ../../../../openspec/specs/monitor/definition/spec.md (payload form)
 * @see ../../../../openspec/specs/pipeline/post-processing/spec.md
 */
import { describe, expect, it } from 'vitest';
import {
  applyPayloadTransform,
  validatePayloadTransform,
  type PayloadTransform,
} from './transform.js';

// The E6 workout snapshot: a computing recipient needs the numbers precisely.
const workoutSnapshot = {
  sets: [
    { weight: 100, reps: 5, rpe: 8, notes: 'warmup' },
    { weight: 110, reps: 3, rpe: 9, notes: 'top set' },
  ],
  heartRate: 142,
};

describe('payload transform — structured + jq (spec: pipeline/post-processing)', () => {
  it('projects exactly the declared fields (E6)', () => {
    // spec: monitor/definition example: project each set's { weight, reps, rpe } — dropping
    // `notes`. jq object-construction uses explicit keys.
    const transform: PayloadTransform = {
      language: 'jq',
      expression: '.sets | map({weight: .weight, reps: .reps, rpe: .rpe})',
    };
    const outcome = applyPayloadTransform(workoutSnapshot, transform);
    expect(outcome.delivered).toBe(true);
    // Hand-written expected projection per the spec example.
    expect(outcome.value).toEqual([
      { weight: 100, reps: 5, rpe: 8 },
      { weight: 110, reps: 3, rpe: 9 },
    ]);
  });

  it('reshapes to a scalar projection', () => {
    const transform: PayloadTransform = {
      language: 'jq',
      expression: '.heartRate',
    };
    const outcome = applyPayloadTransform(workoutSnapshot, transform);
    expect(outcome).toEqual({ delivered: true, value: 142 });
  });
});

describe('payload transform — structured + cel gate (spec: pipeline/post-processing)', () => {
  it('a true gate delivers the canonical (un-reshaped) snapshot', () => {
    // `cel` gates: true delivers the canonical shaped snapshot un-reshaped.
    const transform: PayloadTransform = {
      language: 'cel',
      expression: 'heartRate > 130',
    };
    const outcome = applyPayloadTransform(workoutSnapshot, transform);
    expect(outcome).toEqual({ delivered: true, value: workoutSnapshot });
  });

  it('a false gate suppresses delivery entirely', () => {
    const transform: PayloadTransform = {
      language: 'cel',
      expression: 'heartRate > 200',
    };
    const outcome = applyPayloadTransform(workoutSnapshot, transform);
    expect(outcome.delivered).toBe(false);
    expect(outcome).toEqual({ delivered: false });
  });
});

describe('payload transform — validation (spec: monitor/definition, monitor/validation)', () => {
  it('accepts a well-formed jq transform', () => {
    expect(
      validatePayloadTransform({ language: 'jq', expression: '.heartRate' }),
    ).toBeUndefined();
  });

  it('accepts a well-formed cel transform', () => {
    expect(
      validatePayloadTransform({
        language: 'cel',
        expression: 'heartRate > 130',
      }),
    ).toBeUndefined();
  });

  it('rejects a malformed jq transform', () => {
    expect(
      validatePayloadTransform({
        language: 'jq',
        expression: '.sets[ | broken',
      }),
    ).toBeDefined();
  });

  it('rejects a malformed cel transform', () => {
    expect(
      validatePayloadTransform({ language: 'cel', expression: 'heartRate >' }),
    ).toBeDefined();
  });
});
