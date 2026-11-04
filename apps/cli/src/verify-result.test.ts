/** Failure evidence must survive normal CLI failures and secondary daemon errors. */
import { expect, it, vi } from 'vitest';
import { assertVerifySucceeded } from './test-support/verify-result.js';

it('collects history before rejecting a normal failed report with exit 1', async () => {
  const history = vi.fn(async () => [{ id: 'recorded-change' }]);
  const result = {
    exitCode: 1,
    stdout: '{"ok":false}',
    stderr: 'observe failed',
  };
  await expect(assertVerifySucceeded(result, history)).rejects.toThrow(
    'recorded-change',
  );
  expect(history).toHaveBeenCalledOnce();
});

it('preserves malformed stdout and stderr along with best-effort history', async () => {
  const history = vi.fn(async () => ['durable evidence']);
  const result = { exitCode: 1, stdout: 'not JSON', stderr: 'daemon failed' };
  const failure = assertVerifySucceeded(result, history);
  await expect(failure).rejects.toThrow('not JSON');
  await expect(failure).rejects.toThrow('daemon failed');
  await expect(failure).rejects.toThrow('durable evidence');
});

it('preserves the original failure when history collection throws', async () => {
  const history = vi.fn(async () => {
    throw new Error('socket gone');
  });
  const failure = assertVerifySucceeded(
    { exitCode: 1, stdout: '{"ok":false}', stderr: 'original failure' },
    history,
  );
  await expect(failure).rejects.toThrow('original failure');
  await expect(failure).rejects.toThrow(
    'History unavailable: Error: socket gone',
  );
});

it('performs no diagnostic IPC for a successful verification', async () => {
  const history = vi.fn(async () => []);
  await assertVerifySucceeded(
    { exitCode: 0, stdout: '{"ok":true}', stderr: '' },
    history,
  );
  expect(history).not.toHaveBeenCalled();
});

it('rejects a false report even with exit zero and retains history', async () => {
  await expect(
    assertVerifySucceeded(
      { exitCode: 0, stdout: '{"ok":false}', stderr: '' },
      async () => ['evidence'],
    ),
  ).rejects.toThrow('evidence');
});
