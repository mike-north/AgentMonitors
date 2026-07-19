/**
 * Failure-injection tests for the hook-deliver transport's render-before-commit
 * ordering (issue #442, PR #442 round-9 review).
 *
 * Before this fix, `hook deliver` called `commitDeliveryClient` — the durable
 * `first_notified_at` mutation — BEFORE any hook output was rendered or
 * written to stdout. If the daemon applied the commit but its RPC response
 * was lost, or if rendering/stdout writing failed AFTER commit, the outer
 * try/catch (the hook's always-exit-0 contract) swallowed the error and
 * emitted nothing while the rows were PERMANENTLY excluded from ordinary
 * redelivery (`pendingEventsForSession` never returns an already-claimed
 * row, §5.5). That is an at-most-once loss window.
 *
 * The fix (`reserveRenderAndCommitHookDelivery` + `writeAndCommitHookDelivery`,
 * `hook.ts`) renders off the RESERVATION's own claim first and defers commit
 * until AFTER a successful write:
 *
 * (a) a commit RPC rejection AFTER output was successfully written must
 *     propagate to the caller WITHOUT releasing the reservation — the
 *     daemon-side outcome is genuinely uncertain (it may have applied the
 *     commit before the response was lost), so the safe direction is a
 *     later DUPLICATE delivery, never a loss.
 * (a2) only a commit RPC that RESOLVES null (the reservation's lease
 *     already lapsed) proves the rows were never claimed and are back to
 *     pending — a rejection alone does not prove this.
 * (b) a render/write failure BEFORE commit must release the reservation —
 *     nothing durably claimed, rows return to pending.
 *
 * @see docs/specs/006-agent-integration.md §5.2, §5.5
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DeliveryClaim, DeliveryEventSummary } from '@agentmonitors/core';
import { spawn } from 'node:child_process';
import { closeSync, createWriteStream, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../runtime-client.js', () => ({
  claimDeliveryClient: vi.fn(),
  commitDeliveryClient: vi.fn(),
  diagnoseHookDeliveryClient: vi.fn(),
  listSessionsClient: vi.fn(),
  previewSettledHighDeliveryClient: vi.fn(),
  releaseDeliveryClient: vi.fn(),
  reserveDeliveryClient: vi.fn(),
}));

import {
  reserveRenderAndCommitHookDelivery,
  writeAndCommitHookDelivery,
  writeStreamChunk,
  type HookDeliveryFlowResult,
} from './hook.js';
import {
  commitDeliveryClient,
  previewSettledHighDeliveryClient,
  releaseDeliveryClient,
  reserveDeliveryClient,
} from '../runtime-client.js';
import type { HookDeliveryOutput } from '../hook-deliver-render.js';

const previewMock = vi.mocked(previewSettledHighDeliveryClient);
const reserveMock = vi.mocked(reserveDeliveryClient);
const commitMock = vi.mocked(commitDeliveryClient);
const releaseMock = vi.mocked(releaseDeliveryClient);

function makeEvent(
  overrides: Partial<DeliveryEventSummary> = {},
): DeliveryEventSummary {
  return {
    eventId: 'e1',
    monitorId: 'm1',
    title: 't1',
    summary: 's1',
    urgency: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    body: 'a body',
    ...overrides,
  };
}

function claimWith(surfaced: DeliveryEventSummary[]): DeliveryClaim {
  return {
    sessionId: 'session-1',
    mode: 'delivery',
    urgency: 'high',
    lifecycle: 'turn-interruptible',
    message: `${String(surfaced.length)} monitor(s) fired`,
    unreadCounts: {
      low: 0,
      normal: 0,
      high: surfaced.length,
      total: surfaced.length,
    },
    events: surfaced,
  };
}

beforeEach(() => {
  previewMock.mockReset();
  reserveMock.mockReset();
  commitMock.mockReset();
  releaseMock.mockReset();
});

describe('writeAndCommitHookDelivery ordering (issue #442, round-9 review)', () => {
  function makeFlow(
    output: HookDeliveryOutput | null,
  ): HookDeliveryFlowResult & {
    commit: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  } {
    return {
      output,
      moreDeferred: false,
      previewCount: undefined,
      reservedClaim: claimWith([makeEvent()]),
      commit: vi.fn().mockResolvedValue(claimWith([makeEvent()])),
      release: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('(a) commits only AFTER the write succeeds — write happens strictly before commit', async () => {
    const flow = makeFlow({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'hello',
      },
    });
    const order: string[] = [];
    const write = vi.fn(() => {
      order.push('write');
    });
    flow.commit.mockImplementation(async () => {
      order.push('commit');
      return claimWith([makeEvent()]);
    });

    await writeAndCommitHookDelivery(flow, write);

    expect(order).toEqual(['write', 'commit']);
    expect(flow.release).not.toHaveBeenCalled();
  });

  it('(a) a commit RPC failure AFTER a successful write propagates and never releases — whether the rows ended up claimed is genuinely uncertain, not "stays pending" (issue #442, round-14 review)', async () => {
    const flow = makeFlow({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'hello',
      },
    });
    const write = vi.fn();
    flow.commit.mockRejectedValueOnce(new Error('daemon unreachable'));

    await expect(writeAndCommitHookDelivery(flow, write)).rejects.toThrow(
      'daemon unreachable',
    );

    // The output WAS already written before commit was attempted.
    expect(write).toHaveBeenCalledTimes(1);
    // A commit failure must NOT trigger a release: the reservation's own TTL
    // is the only recovery path here, and releasing after a successful write
    // would be wrong too (there is no "undo the write"). This test proves
    // ONLY that the rejection propagates to the caller and the helper does
    // not release — it does NOT prove the rows "stay pending". Unlike a null
    // resolution (definitely uncommitted, see the next test), a rejected
    // commit RPC leaves the actual row state genuinely uncertain: the daemon
    // may have applied the commit before the response was lost.
    expect(flow.release).not.toHaveBeenCalled();
  });

  it('(a) commit returning null (lease expired) after a successful write is a safe no-op, not an error', async () => {
    const flow = makeFlow({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'hello',
      },
    });
    const write = vi.fn();
    flow.commit.mockResolvedValueOnce(null);

    const claim = await writeAndCommitHookDelivery(flow, write);

    expect(write).toHaveBeenCalledTimes(1);
    expect(claim).toBeNull();
    expect(flow.release).not.toHaveBeenCalled();
  });

  it('(b) a render/write failure releases the reservation instead of committing — nothing durably claimed', async () => {
    const flow = makeFlow({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'hello',
      },
    });
    const write = vi.fn(() => {
      throw new Error('EPIPE: broken stdout pipe');
    });

    await expect(writeAndCommitHookDelivery(flow, write)).rejects.toThrow(
      'EPIPE',
    );

    expect(flow.release).toHaveBeenCalledTimes(1);
    expect(flow.commit).not.toHaveBeenCalled();
  });

  it('never writes and commits unconditionally when output is null (nothing to render)', async () => {
    const flow = makeFlow(null);
    const write = vi.fn();

    const claim = await writeAndCommitHookDelivery(flow, write);

    expect(write).not.toHaveBeenCalled();
    expect(flow.commit).toHaveBeenCalledTimes(1);
    expect(claim).not.toBeNull();
  });

  /**
   * (issue #442, PR #442 round-10 review) `process.stdout.write`'s
   * SYNCHRONOUS return value (`true`/`false`) is a backpressure signal, not a
   * success signal — a write can return `true` immediately and still fail
   * ASYNCHRONOUSLY afterward (e.g. `EPIPE` once the reading end has already
   * closed). Reproduces the reviewer's probe shape: a `write` seam that
   * resolves its "wrote successfully" signal only later, and then rejects —
   * simulating exactly that delayed-EPIPE case — to prove
   * `writeAndCommitHookDelivery` awaits full completion before ever
   * committing, and releases (never commits) on that later failure.
   */
  it('(a bug regression) an async write failure that arrives AFTER a synchronous "wrote" signal must still release, not commit — the write is awaited to full completion', async () => {
    const flow = makeFlow({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'hello',
      },
    });
    const order: string[] = [];

    // Simulates a delayed/erroring Writable: the underlying `stream.write()`
    // call returns `true` synchronously (as a real Writable would under no
    // backpressure), but the promise `writeAndCommitHookDelivery` is handed
    // does not settle until a later microtask/tick, where it rejects — the
    // asynchronous EPIPE the synchronous return value could never signal.
    const write = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          // A synchronous `write()` return of `true` happens here, in the
          // caller's mental model — but the promise itself only rejects
          // later, after this function has already returned to its caller.
          setTimeout(() => {
            order.push('async-write-error');
            reject(new Error('EPIPE: broken stdout pipe'));
          }, 0);
        }),
    );

    await expect(writeAndCommitHookDelivery(flow, write)).rejects.toThrow(
      'EPIPE',
    );

    // The async failure must have been awaited (order recorded) BEFORE this
    // function resolved/rejected — proving the write's completion, not its
    // synchronous return, gated the outcome.
    expect(order).toEqual(['async-write-error']);
    // Never committed: the write ultimately failed, even though it looked
    // like a success at the moment `write()` was called.
    expect(flow.commit).not.toHaveBeenCalled();
    // Released instead — nothing durably claimed, rows return to pending.
    expect(flow.release).toHaveBeenCalledTimes(1);
  });
});

/**
 * (issue #442, PR #442 round-10 review) `writeStreamChunk` is the real seam
 * `hook.ts`'s `deliver` action uses in place of a bare `process.stdout.write`
 * call — it must resolve/reject on the write's actual completion, never the
 * synchronous return value, and must handle an `'error'` event arriving on
 * the stream instead of (or racing) the write callback.
 */
describe('writeStreamChunk (issue #442, round-10 review)', () => {
  it('resolves once the write callback reports success, even though the synchronous write() call returned true', async () => {
    let capturedCallback: ((error?: Error | null) => void) | undefined;
    const stream = {
      write: vi.fn(
        (_chunk: string, callback: (error?: Error | null) => void) => {
          capturedCallback = callback;
          return true; // backpressure signal only — not yet "done"
        },
      ),
      once: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as NodeJS.WritableStream;

    const pending = writeStreamChunk(stream, 'hello');
    // Not yet settled: the callback has not fired.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    capturedCallback?.();
    await expect(pending).resolves.toBeUndefined();
  });

  it("rejects when the write callback reports a delayed/asynchronous error — the reviewer's probe shape: synchronous true return, later error", async () => {
    let capturedCallback: ((error?: Error | null) => void) | undefined;
    const stream = {
      write: vi.fn(
        (_chunk: string, callback: (error?: Error | null) => void) => {
          capturedCallback = callback;
          return true;
        },
      ),
      once: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as NodeJS.WritableStream;

    const pending = writeStreamChunk(stream, 'hello');
    capturedCallback?.(new Error('EPIPE: broken stdout pipe'));

    await expect(pending).rejects.toThrow('EPIPE');
  });

  it('rejects when the stream emits an "error" event instead of the write callback firing', async () => {
    let errorHandler: ((error: Error) => void) | undefined;
    const stream = {
      write: vi.fn(() => true),
      once: vi.fn((event: string, handler: (error: Error) => void) => {
        if (event === 'error') errorHandler = handler;
      }),
      removeListener: vi.fn(),
    } as unknown as NodeJS.WritableStream;

    const pending = writeStreamChunk(stream, 'hello');
    errorHandler?.(new Error('EPIPE: broken stdout pipe'));

    await expect(pending).rejects.toThrow('EPIPE');
  });
});

/**
 * Real-`Writable` regressions for the round-11 review finding: a fake stream
 * that only ever fires the write callback OR only ever emits an 'error'
 * event (the two describe blocks above) cannot reproduce the actual bug —
 * a real Node `Writable` invokes the write callback with an error AND
 * separately EMITS the paired `'error'` event on a LATER tick for that same
 * failure. An earlier version of `writeStreamChunk` removed its only
 * `'error'` listener as soon as the callback settled the promise, so that
 * paired emission had no listener and became an UNCAUGHT exception (issue
 * #442, PR #442 round-11 review). These tests install a real
 * `process.on('uncaughtException', ...)` guard and drive an actually-closed
 * pipe/fd so both signals genuinely fire, proving the promise still rejects
 * exactly once with no uncaught exception and no nonzero-exit crash.
 */
describe('writeStreamChunk against a REAL Writable that pairs a callback error with a later error event (issue #442, round-11 review)', () => {
  it('an fs write stream on a closed fd: callback error, then the paired error event, reject exactly once with no uncaught exception', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'am-write-stream-chunk-'));
    const fd = openSync(join(dir, 'target.txt'), 'w');
    closeSync(fd); // the fd is now invalid; every write to it fails with EBADF
    const stream = createWriteStream('', { fd, autoClose: false });

    const uncaughtErrors: Error[] = [];
    const onUncaught = (error: Error): void => {
      uncaughtErrors.push(error);
    };
    process.on('uncaughtException', onUncaught);
    try {
      let rejectionCount = 0;
      const pending = writeStreamChunk(stream, 'hello').catch(
        (error: Error) => {
          rejectionCount += 1;
          throw error;
        },
      );

      await expect(pending).rejects.toThrow(/EBADF/);

      // Give the paired 'error' event (queued on a later tick by the real
      // Writable) a chance to fire before asserting nothing leaked as
      // uncaught.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(rejectionCount).toBe(1);
      expect(uncaughtErrors).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      stream.destroy();
    }
  });

  it('a spawned child process with its stdin closed: writing produces the paired EPIPE callback-then-event without crashing the process', async () => {
    // The child closes its OWN stdin (`exec 0<&-`) immediately, then sleeps —
    // so our end of the pipe genuinely has no reader. A short delay lets
    // that close land before we write; a multi-megabyte chunk exceeds the
    // OS pipe buffer so the write actually reaches the (closed) kernel pipe
    // rather than merely being buffered in-process, reproducing a REAL
    // `EPIPE` — both the write callback AND the paired `'error'` event fire
    // for it, unlike the single-signal fakes in the describe blocks above.
    const child = spawn('sh', ['-c', 'exec 0<&-; sleep 2']);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));

      const uncaughtErrors: Error[] = [];
      const onUncaught = (error: Error): void => {
        uncaughtErrors.push(error);
      };
      process.on('uncaughtException', onUncaught);
      try {
        let rejectionCount = 0;
        const bigChunk = 'x'.repeat(2 * 1024 * 1024);
        const pending = writeStreamChunk(child.stdin, bigChunk).catch(
          (error: Error) => {
            rejectionCount += 1;
            throw error;
          },
        );

        await expect(pending).rejects.toThrow(/EPIPE/);

        // Give the paired 'error' event (queued on a later tick) a chance
        // to fire before asserting nothing leaked as uncaught.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        expect(rejectionCount).toBe(1);
        expect(uncaughtErrors).toEqual([]);
      } finally {
        process.removeListener('uncaughtException', onUncaught);
      }
    } finally {
      child.kill();
    }
  });
});

describe('reserveRenderAndCommitHookDelivery renders off the reservation, never a committed claim (issue #442, round-9 review)', () => {
  it('the commit callback is independent of rendering — output reflects reservation.claim before commit is ever called', async () => {
    const event = makeEvent({ body: 'monitored body text' });
    // Sizing preview, then the post-reservation candidate-growth revalidation
    // preview (issue #442, PR #442 round-9 review) — both see just this one
    // event, so nothing grew in the gap.
    previewMock.mockResolvedValueOnce([event]);
    previewMock.mockResolvedValueOnce([event]);
    reserveMock.mockResolvedValueOnce({
      reservationId: 'r-1',
      claim: claimWith([event]),
    });

    const flow = await reserveRenderAndCommitHookDelivery(
      'session-1',
      'turn-interruptible',
      '/sock',
      'UserPromptSubmit',
    );

    expect(flow).not.toBeNull();
    expect(flow?.output?.hookSpecificOutput.additionalContext).toContain(
      'monitored body text',
    );
    // Rendering happened WITHOUT ever calling commit.
    expect(commitMock).not.toHaveBeenCalled();

    // Now write + commit via the shared helper, in the correct order.
    commitMock.mockResolvedValueOnce(claimWith([event]));
    const write = vi.fn();
    await writeAndCommitHookDelivery(flow as NonNullable<typeof flow>, write);

    expect(write).toHaveBeenCalledTimes(1);
    expect(commitMock).toHaveBeenCalledWith('r-1', '/sock');
  });
});
