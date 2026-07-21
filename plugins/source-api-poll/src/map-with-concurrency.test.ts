import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapWithConcurrency } from './map-with-concurrency.js';

describe('mapWithConcurrency', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves input order regardless of completion order', async () => {
    const results = await mapWithConcurrency(
      [30, 10, 20],
      3,
      (ms) =>
        new Promise<number>((resolve) => {
          setTimeout(() => {
            resolve(ms);
          }, ms);
        }),
    );
    expect(results).toEqual([30, 10, 20]);
  });

  it('never runs more than `limit` invocations concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(
      Array.from({ length: 9 }, (_, i) => i),
      3,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return null;
      },
    );
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('rejects with the underlying error when a single item fails', async () => {
    await expect(
      mapWithConcurrency([1], 1, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });

  it('is a no-op returning an empty array for an empty input', async () => {
    await expect(
      mapWithConcurrency<number, number>([], 5, (n) => Promise.resolve(n)),
    ).resolves.toEqual([]);
  });

  // Copilot review (PR #448): an unvalidated `limit` <= 0 makes `workerCount`
  // (`Math.min(limit, items.length)`) 0, so the call would previously resolve
  // immediately with an array of uninitialized entries and `fn` never invoked
  // for a non-empty `items` — silent data loss rather than a thrown error.
  describe('limit validation', () => {
    it.each([0, -1, -5])(
      'throws for a non-positive limit (%d) instead of silently dropping all items',
      async (limit) => {
        const fn = vi.fn((n: number) => Promise.resolve(n));
        await expect(mapWithConcurrency([1, 2, 3], limit, fn)).rejects.toThrow(
          /limit must be a positive integer/,
        );
        expect(fn).not.toHaveBeenCalled();
      },
    );

    it.each([1.5, NaN, Infinity])(
      'throws for a non-integer limit (%s)',
      async (limit) => {
        await expect(
          mapWithConcurrency([1], limit, (n) => Promise.resolve(n)),
        ).rejects.toThrow(/limit must be a positive integer/);
      },
    );

    it('accepts a positive integer limit', async () => {
      await expect(
        mapWithConcurrency([1, 2, 3], 2, (n) => Promise.resolve(n * 2)),
      ).resolves.toEqual([2, 4, 6]);
    });
  });

  // Issue #304 review, finding 3: workers previously only checked a shared
  // `failed` flag *between* items, so an instantly-failing part still waited
  // for every in-flight sibling to finish (up to its own full deadline)
  // before the batch surfaced the failure.
  describe('fail-fast + sibling abort (issue #304 review finding 3)', () => {
    it('rejects as soon as the first item fails, without waiting for a sibling that never settles on its own', async () => {
      let siblingAborted = false;

      const promise = mapWithConcurrency(
        ['fails-fast', 'stalls-forever'],
        2,
        (item, signal) => {
          if (item === 'fails-fast') {
            return Promise.reject(new Error('boom'));
          }
          // Never resolves/rejects on its own — only settles if aborted,
          // simulating an in-flight sibling with no natural end.
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              siblingAborted = true;
              reject(new Error('aborted'));
            });
          });
        },
      );

      await expect(promise).rejects.toThrow('boom');
      // The abort listener fires synchronously inside `batchController.abort()`,
      // which runs before the rejection that the assertion above awaited — so
      // by the time `promise` has rejected, the sibling has already been
      // signalled to abort.
      expect(siblingAborted).toBe(true);
    });

    it('rejects fast even when the sibling would otherwise take its own full timeout to fail', async () => {
      vi.useFakeTimers();

      const promise = mapWithConcurrency(
        ['fails-fast', 'slow-deadline'],
        2,
        (item, signal) => {
          if (item === 'fails-fast') {
            return Promise.reject(new Error('boom'));
          }
          // Mirrors `fetchBody`'s own per-part deadline: it would eventually
          // reject after 30s, but only if never aborted first.
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve('too-late');
            }, 30_000);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          });
        },
      );

      await expect(promise).rejects.toThrow('boom');
      // The sibling's 30s deadline timer was cleared by the abort listener —
      // no fake-timer advance was needed to reach this rejection, proving the
      // batch did not wait for it.
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
