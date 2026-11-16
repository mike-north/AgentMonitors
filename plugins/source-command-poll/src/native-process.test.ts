/** Parent-side native consumers share one lazy loader and libc handle. */
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const func = vi.fn(() => () => 0);
  const load = vi.fn(() => ({ func }));
  const errno = vi.fn(() => 5);
  const requireNative = vi.fn(() => ({ load, errno }));
  return { func, load, errno, requireNative };
});
vi.mock('node:module', () => ({ createRequire: () => fixture.requireNative }));
vi.mock('./native-binding.js', () => ({
  vendoredNativeLoader: () => '/fixture/load.cjs',
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it('keeps inert imports free of native initialization', async () => {
  await import('./native-process.js');
  expect(fixture.requireNative).not.toHaveBeenCalled();
  expect(fixture.load).not.toHaveBeenCalled();
});

it('shares one binding and libc handle across capture and adopted-watchdog consumers', async () => {
  const { nativeProcessLibrary } = await import('./native-process.js');
  const capture = nativeProcessLibrary();
  capture.func('int getrlimit(int resource, void *value)');
  const reaper = nativeProcessLibrary();
  reaper.func('int prctl(int option, ...)');
  reaper.func('int waitpid(int pid, void *status, int options)');
  expect(reaper).toBe(capture);
  expect(capture.errno()).toBe(5);
  expect(fixture.requireNative).toHaveBeenCalledExactlyOnceWith(
    '/fixture/load.cjs',
  );
  expect(fixture.load).toHaveBeenCalledExactlyOnceWith(null);
});
