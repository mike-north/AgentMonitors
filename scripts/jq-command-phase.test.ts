/** The negative jq control separates startup from its strict command verdict. */
import { expect, it } from 'vitest';
import {
  assertJqCommandBudget,
  negativeJqPhaseDeadline,
} from './jq-command-phase.mjs';

it('does not charge slow startup to the jq/report allowance', () => {
  // Startup can exceed a command window; jq still receives its own deadline.
  // An explicit clock keeps this boundary independent of machine load.
  const started = 0;
  const jqStarted = 6_841;
  const reported = jqStarted + 1_100;
  expect(reported).toBeGreaterThan(started + 5_000);
  expect(negativeJqPhaseDeadline(started, jqStarted, reported)).toBe(11_841);
  expect(reported).toBeLessThan(
    negativeJqPhaseDeadline(started, jqStarted, reported),
  );
  expect(() =>
    assertJqCommandBudget('jq command deadline expired (1000ms)'),
  ).not.toThrow();
});

it('bounds startup independently and names its elapsed time', () => {
  expect(negativeJqPhaseDeadline(100, undefined, 7_099)).toBe(7_100);
  expect(() => negativeJqPhaseDeadline(100, undefined, 7_100)).toThrow(
    'Negative jq driver startup deadline expired (elapsed 7000ms; allowance 7000ms)',
  );
  // A phase beginning at or after its startup deadline cannot rescue it.
  expect(() => negativeJqPhaseDeadline(100, 7_100, 7_200)).toThrow(
    'Negative jq driver startup deadline expired (elapsed 7000ms; allowance 7000ms)',
  );
});

it('does not restart the jq/report allowance while waiting for a report', () => {
  expect(negativeJqPhaseDeadline(0, 800, 1_000)).toBe(5_800);
  expect(negativeJqPhaseDeadline(0, 800, 5_800)).toBe(5_800);
});

it.each([
  'jq command deadline expired (2000ms)',
  'jq command deadline expired',
  'another failure (1000ms)',
  '',
])('rejects a verdict without the one-second jq budget: %s', (message) => {
  expect(() => assertJqCommandBudget(message)).toThrow(
    'Expected the unchanged 1000ms jq command deadline failure',
  );
});

it('keeps startup outside the seven-second command test and reserves cleanup', () => {
  const started = 0;
  const jqStarted = 6_841;
  const reported = jqStarted + 1_100;
  expect(reported - started).toBeGreaterThan(7_000);
  const commandDeadline = negativeJqPhaseDeadline(started, jqStarted, reported);
  expect(commandDeadline - jqStarted).toBe(5_000);
  expect(jqStarted + 7_000 - commandDeadline).toBe(2_000);
});
