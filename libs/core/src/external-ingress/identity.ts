/**
 * Stable identity for the closed external-event v1 semantic field set.
 * Relay cursors and caller-added transport metadata have no effect on identity.
 */
import { createHash } from 'node:crypto';
import type { ExternalEventEnvelope } from './contract.js';
import { canonicalJsonStringify } from './json.js';

/**
 * Return lowercase SHA-256 hex of canonical JSON for the eleven v1 semantic fields.
 * Object keys sort recursively; array order and timestamp spelling remain semantic.
 * Callers supply validated envelopes. Future schema fields require an explicit
 * identity decision rather than silently changing persisted receipt keys.
 * @public
 */
export function externalEventSemanticHash(
  envelope: ExternalEventEnvelope,
): string {
  const semantic = {
    schema: envelope.schema,
    monitorId: envelope.monitorId,
    source: envelope.source,
    upstreamEventId: envelope.upstreamEventId,
    objectId: envelope.objectId,
    objectSequence: envelope.objectSequence,
    eventKind: envelope.eventKind,
    changeKind: envelope.changeKind,
    occurredAt: envelope.occurredAt,
    scope: envelope.scope,
    state: envelope.state,
  };
  return createHash('sha256')
    .update(canonicalJsonStringify(semantic))
    .digest('hex');
}

/**
 * Encode the source/object pair as `external:` plus canonical JSON of the tuple.
 * JSON escaping preserves tuple boundaries even when identities contain delimiters.
 * @public
 */
export function externalEventObjectKey(
  source: string,
  objectId: string,
): string {
  return `external:${canonicalJsonStringify([source, objectId])}`;
}
