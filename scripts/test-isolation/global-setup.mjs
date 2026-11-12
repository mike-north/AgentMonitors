/** The coordinator owns cleanup and host-path checks across all worker lifetimes. */
import { createTestBoundary } from './boundary.mjs';

/** @param {{provide: (key: string, value: string) => void}} project @internal */
export default function setup(project) {
  const boundary = createTestBoundary();
  project.provide('testIsolationRoot', boundary.root);
  return boundary.finish;
}
