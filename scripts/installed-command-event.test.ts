/** A native-admission refusal must never masquerade as the installed CLI's output-change proof. */
import { describe, expect, it } from 'vitest';
import { assertInstalledCommandChange } from './test-standalone-consumer.mjs';

const changed = {
  monitorId: 'command-native',
  summary: 'Command output changed: fixture',
  snapshotText: 'two',
  payload: { stdout: 'two', exitCode: 0 },
};
describe('installed CLI command output evidence', () => {
  it('accepts the persisted successful output-change event', () => {
    expect(() => assertInstalledCommandChange(changed)).not.toThrow();
  });
  it.each([
    { ...changed, summary: 'Command failing: fixture' },
    { ...changed, summary: 'Command recovered: fixture' },
    { ...changed, snapshotText: 'one' },
    { ...changed, payload: { stdout: 'one', exitCode: 0 } },
    { ...changed, payload: { stdout: 'two', exitCode: 1 } },
    {
      ...changed,
      payload: {
        stdout: 'two',
        exitCode: 0,
        error: 'Could not arm command lifetime bound',
      },
    },
  ])(
    'rejects a failure transition or incorrect command result: %j',
    (event) => {
      expect(typeof assertInstalledCommandChange).toBe('function');
      expect(() => assertInstalledCommandChange(event)).toThrow();
    },
  );
});
