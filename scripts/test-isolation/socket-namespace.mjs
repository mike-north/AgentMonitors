/**
 * Primary runtime-namespace boundary for Node test code and preloaded children.
 * Known fallback joins still relocate into owned roots. Any resulting real
 * per-user/legacy path, including an explicit IO path, is a fatal run violation.
 * Synchronous receipts retain caught errors and transient accesses; the host
 * observer uses separately captured read-only primitives rather than this API.
 */
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { inspection } from './native-inspection.mjs';
import {
  appendNamespaceViolation,
  namespaceViolations,
  scopeFromEnvironment,
  validateScope,
} from './namespace-scope.mjs';
import {
  filesystemPath,
  isRuntimePath,
  runtimeNamespaces,
} from './runtime-paths.mjs';

const installed = Symbol.for('agentmonitors.testSocketNamespace');

/**
 * Built-ins survive Vitest file-cache resets. One stable state owns wrappers;
 * each file/child supplies its current run receipt without stacking wrappers.
 * @param {import('./namespace-scope.mjs').NamespaceScope} [providedScope] @internal
 */
export function installSocketNamespace(providedScope) {
  const scope = providedScope
    ? validateScope(providedScope)
    : scopeFromEnvironment();
  if (path[installed]) {
    if (scope) {
      path[installed].scope = scope;
    }
    path[installed].namespaces = runtimeNamespaces(
      process.env.AGENTMONITORS_TEST_EXTRA_RUNTIME_BASE ?? scope?.extraBase,
    );
    return;
  }
  const state = {
    scope,
    namespaces: runtimeNamespaces(
      process.env.AGENTMONITORS_TEST_EXTRA_RUNTIME_BASE ?? scope?.extraBase,
    ),
    violations: [],
  };
  Object.defineProperty(path, installed, { value: state });

  /** Record before throwing: a caller catching the error cannot grant permission. */
  function violation(operation, value) {
    const file = filesystemPath(value) ?? String(value);
    const error = new Error(`Runtime namespace access: ${operation}: ${file}`);
    error.code = 'ERR_TEST_RUNTIME_NAMESPACE';
    const record = {
      pid: process.pid,
      operation,
      path: file,
      stack: error.stack,
    };
    state.violations.push(record);
    if (state.scope) {
      try {
        appendNamespaceViolation(state.scope, record);
      } catch (cause) {
        console.error('Cannot persist runtime violation:', cause);
      }
    }
    console.error(error.stack);
    throw error;
  }
  /** All path-bearing entry points share one semantic test. */
  function check(operation, value) {
    if (inspection.active()) {
      return;
    }
    if (isRuntimePath(value, state.namespaces)) {
      violation(operation, value);
    }
  }

  const originalJoin = path.join;
  path.join = (...parts) => {
    if (
      parts[0] === '/tmp' &&
      /^agentmonitors-(?:\d+|[a-f0-9]{16}\.sock)$/.test(parts[1] ?? '')
    ) {
      const root = process.env.AGENTMONITORS_TEST_SOCKET_ROOT;
      if (!root) {
        violation(
          'path.join (missing owned namespace)',
          originalJoin(...parts),
        );
      }
      const result = originalJoin(root, ...parts.slice(1));
      check('path.join fallback target', result);
      return result;
    }
    for (const part of parts) {
      check('path.join input', part);
    }
    const result = originalJoin(...parts);
    check('path.join result', result);
    return result;
  };
  for (const name of [
    'resolve',
    'normalize',
    'dirname',
    'basename',
    'extname',
    'relative',
    'parse',
    'format',
    'toNamespacedPath',
  ]) {
    const original = path[name];
    path[name] = function (...args) {
      for (const arg of args) {
        check(`path.${name} input`, arg);
      }
      const result = Reflect.apply(original, this, args);
      check(`path.${name} result`, result);
      return result;
    };
  }

  const guardedFunctions = new WeakMap();
  /** Preserve native/custom-promisify call forms as well as ordinary callbacks. */
  function guardedFileFunction(name, original, count) {
    if (guardedFunctions.has(original)) {
      return guardedFunctions.get(original);
    }
    const guarded = function (...args) {
      for (const value of args.slice(0, count)) {
        check(`fs.${name}`, value);
      }
      return Reflect.apply(original, this, args);
    };
    // Promisify metadata can point back to the function itself.
    guardedFunctions.set(original, guarded);
    for (const key of Reflect.ownKeys(original)) {
      if (
        ['length', 'name', 'prototype', 'arguments', 'caller'].includes(
          String(key),
        )
      ) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(original, key);
      if (typeof descriptor?.value === 'function') {
        descriptor.value = guardedFileFunction(name, descriptor.value, count);
      }
      if (descriptor) {
        Object.defineProperty(guarded, key, descriptor);
      }
    }
    return guarded;
  }
  // The first arguments are filesystem locations; descriptors, data, flags and
  // callbacks remain untouched. Rename/copy/link have two location arguments.
  const pairs = new Set(['rename', 'copyFile', 'cp', 'link', 'symlink']);
  const operations = [
    'access',
    'appendFile',
    'chmod',
    'chown',
    'copyFile',
    'cp',
    'exists',
    'lchmod',
    'lchown',
    'link',
    'lstat',
    'lutimes',
    'mkdir',
    'mkdtemp',
    'open',
    'openAsBlob',
    'opendir',
    'readFile',
    'readdir',
    'readlink',
    'realpath',
    'rename',
    'rm',
    'rmdir',
    'stat',
    'statfs',
    'symlink',
    'truncate',
    'unlink',
    'utimes',
    'watch',
    'watchFile',
    'unwatchFile',
    'writeFile',
    'createReadStream',
    'createWriteStream',
  ];
  for (const name of operations) {
    for (const variant of [name, name + 'Sync']) {
      if (typeof fs[variant] === 'function') {
        fs[variant] = guardedFileFunction(
          variant,
          fs[variant],
          pairs.has(name) ? 2 : 1,
        );
      }
    }
    if (typeof fs.promises[name] === 'function') {
      fs.promises[name] = guardedFileFunction(
        `promises.${name}`,
        fs.promises[name],
        pairs.has(name) ? 2 : 1,
      );
    }
  }
  for (const [prototype, method] of [
    [net.Server.prototype, 'listen'],
    [net.Socket.prototype, 'connect'],
  ]) {
    const original = prototype[method];
    prototype[method] = function (...args) {
      const first = Array.isArray(args[0]) ? args[0][0] : args[0];
      const address =
        typeof first === 'object' && first !== null
          ? first.path
          : typeof first === 'string'
            ? first
            : undefined;
      check(`net.${method}`, address);
      return Reflect.apply(original, this, args);
    };
  }
  // Direct child locations are opened by the parent before a Node preload can
  // run. Guard cwd and explicit path arguments without rewriting its environment
  // or interpreting arbitrary shell programs.
  for (const name of [
    'spawn',
    'spawnSync',
    'execFile',
    'execFileSync',
    'fork',
    'exec',
    'execSync',
  ]) {
    const original = childProcess[name];
    childProcess[name] = function (...args) {
      check(`child_process.${name}`, args[0]);
      for (const arg of args) {
        if (Array.isArray(arg)) {
          for (const value of arg) {
            if (typeof value === 'string' && value.startsWith('/')) {
              check(`child_process.${name} argument`, value);
            }
          }
        } else if (arg && typeof arg === 'object' && 'cwd' in arg) {
          check(`child_process.${name} cwd`, arg.cwd);
        }
      }
      return Reflect.apply(original, this, args);
    };
  }
  const originalChdir = process.chdir;
  process.chdir = function (directory) {
    check('process.chdir', directory);
    return originalChdir(directory);
  };
  process.once('exit', () => {
    if (state.violations.length) {
      process.exitCode = 1;
    }
  });
  syncBuiltinESMExports();
}

/** A coordinator checks all worker/child receipts before removing its run root. @param {string} root @internal */
export function assertNoRuntimeAccess(root) {
  const records = namespaceViolations(root);
  const local = path[installed]?.violations ?? [];
  if (records.length || local.length) {
    const stacks = [
      ...new Set([...records, ...local].map((record) => record.stack)),
    ];
    throw new Error(`Runtime namespace access recorded:\n${stacks.join('\n')}`);
  }
}
