import type { SourceRegistry } from '@mike-north/core';
import fileFingerprint from '@mike-north/source-file-fingerprint';
import apiPoll from '@mike-north/source-api-poll';
import schedule from '@mike-north/source-schedule';

/**
 * Register all bundled core observation sources.
 */
export function registerCoreSources(registry: SourceRegistry): void {
  registry.register(fileFingerprint);
  registry.register(apiPoll);
  registry.register(schedule);
}
