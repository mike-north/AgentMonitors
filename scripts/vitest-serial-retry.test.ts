/**
 * The daemon gate must expose a failing first attempt. A suite-wide retry can
 * turn a durable-state defect into a green run and erase its diagnostic signal.
 */
import { expect, it } from 'vitest';
import config from '../apps/cli/vitest.serial.config.js';

it('requires serial daemon tests to pass on their first attempt', () => {
  expect(config.test?.retry ?? 0).toBe(0);
});
