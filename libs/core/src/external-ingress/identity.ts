import { createHash } from 'node:crypto';
import type { ExternalEventEnvelope } from './contract.js';
import { canonicalJsonStringify } from './json.js';

/** Hash every semantic envelope field while excluding only the relay cursor. */
export function externalEventSemanticHash(
  envelope: ExternalEventEnvelope,
): string {
  const { resumeToken: _resumeToken, ...semantic } = envelope;
  return createHash('sha256')
    .update(canonicalJsonStringify(semantic))
    .digest('hex');
}

/** Build a collision-free source/object tuple key for the snapshot pipeline. */
export function externalEventObjectKey(
  source: string,
  objectId: string,
): string {
  return `external:${canonicalJsonStringify([source, objectId])}`;
}
