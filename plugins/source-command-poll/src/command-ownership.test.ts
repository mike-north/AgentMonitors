/** Optional numeric bookkeeping must never dismantle live command supervision. */
import { waitForOwnedGroupTermination } from '../../../scripts/owned-test-group.mjs';
import { expect, it, vi } from 'vitest';
import { createCommandPollSource } from './index.js';

for (const failure of ['spawned', 'exited'] as const) {
  it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
    `keeps managing and collecting a command when ${failure} PID bookkeeping fails`,
    async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let group: number | undefined;
      try {
        const source = createCommandPollSource({
          environment: async () => ({
            AGENTMONITORS_COMMAND_LIFE: 'test-owner',
          }),
          spawned: (pid) => {
            group = pid;
            if (failure === 'spawned') throw new Error('disk unavailable');
          },
          exited: () => {
            if (failure === 'exited') throw new Error('disk unavailable');
          },
        });
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
        if (group !== undefined) await cleanupGroup(group);
      }
    },
  );
}

/** Preserve termination evidence even when the observation assertion fails. */
async function cleanupGroup(group: number): Promise<void> {
  try {
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
      throw error;
  }
  await waitForOwnedGroupTermination(group, Date.now() + 5_000);
}
