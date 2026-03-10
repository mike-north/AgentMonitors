import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { globSync } from 'glob';
import type {
  JsonSchema,
  Observation,
  ObservationSource,
} from '@agentmonitors/core';

interface ScopeConfig {
  globs: string[];
  cwd: string | undefined;
}

function parseScopeConfig(config: Record<string, unknown>): ScopeConfig {
  const globs = config['globs'];
  if (
    !Array.isArray(globs) ||
    !globs.every((g): g is string => typeof g === 'string')
  ) {
    throw new Error('scope.globs must be an array of strings');
  }
  const cwd = typeof config['cwd'] === 'string' ? config['cwd'] : undefined;
  return { globs, cwd };
}

async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/** Derive a stable cache namespace from the full scope config. */
function configNamespace(config: Record<string, unknown>): string {
  return JSON.stringify(config);
}

const scopeSchema: JsonSchema = {
  type: 'object',
  properties: {
    globs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Glob patterns to match files',
    },
    cwd: {
      type: 'string',
      description: 'Working directory for glob resolution',
    },
  },
  required: ['globs'],
};

/** Track previous fingerprints keyed by config namespace + file path. */
const fingerprints = new Map<string, string>();

const source: ObservationSource = {
  name: 'file-fingerprint',
  scopeSchema,

  async observe(config: Record<string, unknown>): Promise<Observation[]> {
    const { globs, cwd } = parseScopeConfig(config);
    const namespace = configNamespace(config);
    const observations: Observation[] = [];

    for (const pattern of globs) {
      const files = globSync(pattern, {
        ...(cwd !== undefined ? { cwd } : {}),
        absolute: true,
      });

      for (const filePath of files) {
        const hash = await hashFile(filePath);
        const key = `${namespace}\0${filePath}`;
        const previousHash = fingerprints.get(key);

        if (previousHash !== undefined && previousHash !== hash) {
          observations.push({
            title: `File changed: ${filePath}`,
            snapshot: {
              filePath,
              previousHash,
              currentHash: hash,
            },
          });
        }

        fingerprints.set(key, hash);
      }
    }

    return observations;
  },
};

export default source;
