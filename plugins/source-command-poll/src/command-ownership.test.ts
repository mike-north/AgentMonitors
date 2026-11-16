/** Optional numeric bookkeeping must never dismantle live command supervision. */
import { waitForOwnedGroupTermination } from '../../../scripts/owned-test-group.mjs';
import { afterEach, expect, it, vi } from 'vitest';
import { createCommandPollSource } from './index.js';

/** Cancellation retains the source's live handle/control channel instead of guessing at a reaped PGID. */
interface IOwnedFixture {
  readonly shutdown: AbortController;
  group?: number;
}
const fixtures: IOwnedFixture[] = [];

// A timed-out observation must restore instrumentation and stop its owned work.
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await cleanupGroup(fixture);
});

for (const failure of ['spawned', 'exited'] as const) {
  it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
    `keeps managing and collecting a command when ${failure} PID bookkeeping fails`,
    async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const fixture: IOwnedFixture = { shutdown: new AbortController() };
      fixtures.push(fixture);
      try {
        const source = createCommandPollSource(
          {
            environment: async () => ({
              AGENTMONITORS_COMMAND_LIFE: 'test-owner',
            }),
            spawned: (pid) => {
              fixture.group = pid;
              if (failure === 'spawned') throw new Error('disk unavailable');
            },
            exited: () => {
              if (failure === 'exited') throw new Error('disk unavailable');
            },
          },
          fixture.shutdown.signal,
        );
        const result = await source.observe(
          {
            command: [
              process.execPath,
              '-e',
              'process.stdout.write(process.env.AGENTMONITORS_COMMAND_LIFE)',
            ],
            env: { AGENTMONITORS_COMMAND_LIFE: 'authored-override' },
            timeout: '1s',
          },
          { now: new Date() },
        );
        expect(result.nextState).toEqual(
          expect.objectContaining({ stdout: 'test-owner', health: 'ok' }),
        );
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining('PID bookkeeping'),
        );
      } finally {
        stderr.mockRestore();
        await cleanupGroup(fixture);
      }
    },
  );
}

/** Preserve termination evidence even when the observation assertion fails. */
async function cleanupGroup(fixture: IOwnedFixture): Promise<void> {
  fixture.shutdown.abort();
  if (fixture.group !== undefined) {
    await waitForOwnedGroupTermination(fixture.group, Date.now() + 5_000);
  }
}
