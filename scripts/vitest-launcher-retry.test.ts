/**
 * The launcher gate must expose a failing first attempt. A suite-wide retry hid
 * a real race here: another suite deleted the CLI build while the launcher ran,
 * and the immediate re-run landed after the build had finished.
 */
import { expect, it } from 'vitest';
import config from '../apps/agentmonitors/vitest.config.js';

it('requires launcher tests to pass on their first attempt', () => {
  expect(config.test?.retry ?? 0).toBe(0);
});
