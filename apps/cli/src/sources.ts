import type { SourceRegistry } from '@agentmonitors/core';
import fileFingerprint from '@agentmonitors/source-file-fingerprint';
import apiPoll from '@agentmonitors/source-api-poll';
import schedule from '@agentmonitors/source-schedule';
import incomingChanges from '@agentmonitors/source-incoming-changes';

/**
 * Register all bundled core observation sources.
 */
export function registerCoreSources(registry: SourceRegistry): void {
  registry.register(fileFingerprint);
  registry.register(apiPoll);
  registry.register(schedule);
  registry.register(incomingChanges);
}
