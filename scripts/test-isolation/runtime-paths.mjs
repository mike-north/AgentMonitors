/** Fixed socket namespaces, independent of HOME/XDG and of the adapter's path wrappers. */
import { Buffer } from 'node:buffer';
import { fileURLToPath, URL } from 'node:url';
import { inspection } from './native-inspection.mjs';

/** @typedef {{base: string, directory: string, aliases: string[]}} RuntimeNamespace */

/**
 * The extra base is used only by owned fake-host fixtures. It adds a forbidden
 * namespace; it never removes the actual per-user/legacy namespaces.
 * @param {string | undefined} [extraBase] @returns {RuntimeNamespace[]} @internal
 */
export function runtimeNamespaces(
  extraBase = process.env.AGENTMONITORS_TEST_EXTRA_RUNTIME_BASE,
) {
  const bases = [
    ...new Set([
      ...(process.platform === 'win32' ? [] : ['/tmp']),
      ...(extraBase ? [extraBase] : []),
    ]),
  ];
  return bases.map((base) => {
    const logical = inspection.path.resolve(base);
    let physical = logical;
    try {
      physical = inspection.fs.realpathSync(logical);
    } catch {
      /* An absent fake base still has a lexical identity. */
    }
    return {
      base: logical,
      directory: inspection.path.join(
        logical,
        `agentmonitors-${inspection.uid}`,
      ),
      aliases: [...new Set([logical, physical])],
    };
  });
}

/** @param {string} name @returns {boolean} @internal */
export function legacyRuntimeName(name) {
  return /^agentmonitors-[a-f0-9]{16}\.sock(?:$|[./])/.test(name);
}

/**
 * Accept ordinary filesystem argument types without reinterpreting file
 * descriptors, ports, or callbacks as paths. Normalize aliases and dot segments.
 * @param {unknown} value @returns {string | undefined} @internal
 */
export function filesystemPath(value) {
  if (value instanceof URL) {
    return fileURLToPath(value);
  }
  if (Buffer.isBuffer(value)) {
    return value.toString();
  }
  return typeof value === 'string' ? value : undefined;
}

/** @param {unknown} value @param {RuntimeNamespace[]} namespaces @returns {boolean} @internal */
export function isRuntimePath(value, namespaces = runtimeNamespaces()) {
  const file = filesystemPath(value);
  if (file === undefined) {
    return false;
  }
  const normalized = inspection.path.resolve(file);
  for (const namespace of namespaces) {
    for (const base of namespace.aliases) {
      if (!normalized.startsWith(base + inspection.separator)) {
        continue;
      }
      const tail = normalized.slice(base.length + 1);
      const ownDirectory = `agentmonitors-${inspection.uid}`;
      if (
        tail === ownDirectory ||
        tail.startsWith(ownDirectory + inspection.separator) ||
        legacyRuntimeName(tail)
      ) {
        return true;
      }
    }
  }
  return false;
}
