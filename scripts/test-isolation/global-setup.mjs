import { setImmediate } from 'node:timers';
/** The coordinator owns cleanup and host-path checks across all worker lifetimes. */
import { createTestBoundary } from './boundary.mjs';

/** @param {{provide: (key: string, value: string) => void}} project @internal */
export default async function setup(project) {
  const boundary = createTestBoundary();
  // Native watch registration must reach the event loop before test work starts.
  await new Promise(setImmediate);
  project.provide('testIsolationRoot', boundary.root);
  return async () => {
    // Give native observation callbacks their final event-loop turn. Safety
    // still rests on synchronous receipts and endpoint snapshots at exit.
    await new Promise(setImmediate);
    boundary.finish();
  };
}
