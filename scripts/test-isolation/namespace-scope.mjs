import { URL } from 'node:url';
/**
 * Run-owned violation receipts bridge workers/children back to their coordinator.
 * Scope travels in the preload URL as well as env, so retaining NODE_OPTIONS is
 * sufficient even for a child with an allowlisted environment. Only a coordinator
 * that created the temp root creates its marker; children verify that capability.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { inspection } from './native-inspection.mjs';

// Capability and violation receipt have run lifetime, never case lifetime.
const marker = '.namespace-scope';
const receipt = '.namespace-violations.jsonl';
const preload = new URL('./socket-preload.mjs', import.meta.url);
const nativeAppend = appendFileSync;
const nativeWrite = writeFileSync;

/** @typedef {{root: string, token: string, extraBase?: string}} NamespaceScope */

/** Only call for the fresh exclusively owned root returned by mkdtemp. @param {string} root @internal */
export function initializeNamespaceScope(root) {
  nativeWrite(inspection.path.join(root, marker), randomUUID(), {
    mode: 0o600,
    flag: 'wx',
  });
}

/** A scope is authority to append to one owned receipt, not to arbitrary paths. @param {NamespaceScope} scope @returns {NamespaceScope} @internal */
export function validateScope(scope) {
  if (
    !scope ||
    typeof scope.root !== 'string' ||
    typeof scope.token !== 'string' ||
    inspection.fs.readFileSync(
      inspection.path.join(scope.root, marker),
      'utf8',
    ) !== scope.token
  ) {
    throw new Error('Invalid test namespace scope');
  }
  return scope;
}

/** @returns {NamespaceScope | undefined} @internal */
export function scopeFromEnvironment() {
  const value = process.env.AGENTMONITORS_TEST_NAMESPACE_SCOPE;
  return value ? validateScope(JSON.parse(value)) : undefined;
}

/**
 * Replace only our unquoted URL token, preserving unrelated NODE_OPTIONS and
 * their quoting. Each child receives one current run capability.
 * @param {string} root @returns {Record<string,string>} @internal
 */
export function namespaceEnvironment(root) {
  const scope = {
    root,
    token: inspection.fs.readFileSync(
      inspection.path.join(root, marker),
      'utf8',
    ),
    extraBase: process.env.AGENTMONITORS_TEST_EXTRA_RUNTIME_BASE,
  };
  const url = new URL(preload);
  url.searchParams.set('scope', JSON.stringify(scope));
  const ownOption = `--import=${preload.href}`;
  const escaped = ownOption.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inherited = (process.env.NODE_OPTIONS ?? '')
    .replace(new RegExp(`(?:^|\\s)${escaped}(?:\\?\\S*)?(?=\\s|$)`, 'g'), ' ')
    .trim();
  return {
    AGENTMONITORS_TEST_NAMESPACE_SCOPE: JSON.stringify(scope),
    NODE_OPTIONS: `${inherited} --import=${url.href}`.trim(),
  };
}

/** Append synchronously: caught exceptions and process.exit cannot erase a violation. @param {NamespaceScope} scope @param {object} violation @internal */
export function appendNamespaceViolation(scope, violation) {
  validateScope(scope);
  nativeAppend(
    inspection.path.join(scope.root, receipt),
    JSON.stringify(violation) + '\n',
    { mode: 0o600 },
  );
}

/** @param {string} root @returns {object[]} @internal */
export function namespaceViolations(root) {
  try {
    return inspection.fs
      .readFileSync(inspection.path.join(root, receipt), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
}
