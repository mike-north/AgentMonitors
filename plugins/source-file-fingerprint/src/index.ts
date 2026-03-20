import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { globSync } from 'glob';
import type {
  JsonSchema,
  Observation,
  ObservationContext,
  ObservationResult,
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

interface FingerprintState {
  fingerprints: Record<string, string>;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFingerprintState(value: unknown): value is FingerprintState {
  if (!isUnknownRecord(value)) {
    return false;
  }

  const fingerprints = value['fingerprints'];
  return isUnknownRecord(fingerprints);
}

function parsePreviousState(previousState: unknown): FingerprintState {
  if (isFingerprintState(previousState)) {
    return previousState;
  }
  return { fingerprints: {} };
}

const source: ObservationSource = {
  name: 'file-fingerprint',
  stateful: true,
  scopeSchema,

  async observe(
    config: Record<string, unknown>,
    context: ObservationContext = { now: new Date() },
  ): Promise<ObservationResult> {
    const { globs, cwd } = parseScopeConfig(config);
    const previous = parsePreviousState(context.previousState);
    const observations: Observation[] = [];
    const nextFingerprints: Record<string, string> = {};

    for (const pattern of globs) {
      const files = globSync(pattern, {
        ...(cwd !== undefined ? { cwd } : {}),
        absolute: true,
      });

      for (const filePath of files) {
        const hash = await hashFile(filePath);
        const previousHash = previous.fingerprints[filePath];
        nextFingerprints[filePath] = hash;

        if (previousHash !== undefined && previousHash !== hash) {
          const content = await readFile(filePath);
          const observation: Observation = {
            title: `File changed: ${filePath}`,
            summary: `File changed: ${filePath}`,
            payload: { filePath, previousHash, currentHash: hash },
            objectKey: filePath,
            queryScope: { filePath },
            snapshot: {
              filePath,
              previousHash,
              currentHash: hash,
            },
          };
          if (!content.includes(0)) {
            observation.snapshotText = content.toString('utf-8');
          }
          observations.push(observation);
        }
      }
    }

    return {
      observations,
      nextState: { fingerprints: nextFingerprints },
    };
  },
};

export default source;
