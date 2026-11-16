/**
 * Install the path boundary before test modules load. File-scoped fixtures
 * (including beforeAll resources) have a file lifetime; ordinary test data and
 * temporary files have a case lifetime, even when a case fails or times out.
 * Hooks registered by test files run inside this boundary and tear down first.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, inject } from 'vitest';
import { installSocketNamespace } from './socket-namespace.mjs';
import {
  applyEnvironment,
  createEnvironmentDirectories,
  isolatedEnvironment,
} from './paths.mjs';

const runRoot = inject('testIsolationRoot');
const fileRoot = mkdtempSync(path.join(runRoot, 'f'));
const fileEnv = isolatedEnvironment(fileRoot, runRoot);
const inheritedEnv = Object.fromEntries(
  Object.keys(fileEnv).map((key) => [key, process.env[key]]),
);
createEnvironmentDirectories(fileEnv);
applyEnvironment(fileEnv);
installSocketNamespace();
/** @type {string | undefined} */
let caseRoot;
const cleanup = () => {
  if (caseRoot) rmSync(caseRoot, { recursive: true, force: true });
  rmSync(fileRoot, { recursive: true, force: true });
};
process.once('exit', cleanup);

beforeEach(() => {
  caseRoot = mkdtempSync(path.join(runRoot, 't'));
  const env = isolatedEnvironment(caseRoot, runRoot);
  createEnvironmentDirectories(env);
  applyEnvironment(env);
});
afterEach(() => {
  if (caseRoot) rmSync(caseRoot, { recursive: true, force: true });
  caseRoot = undefined;
  applyEnvironment(fileEnv);
});
afterAll(() => {
  cleanup();
  applyEnvironment(inheritedEnv);
  process.removeListener('exit', cleanup);
});
