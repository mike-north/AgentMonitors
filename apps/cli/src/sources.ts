import type { CommandProcessOwner, SourceRegistry } from '@agentmonitors/core';
import fileFingerprint from '@agentmonitors/source-file-fingerprint';
import apiPoll from '@agentmonitors/source-api-poll';
import { createCommandPollSource } from '@agentmonitors/source-command-poll';
import schedule from '@agentmonitors/source-schedule';
import incomingChanges from '@agentmonitors/source-incoming-changes';

/**
 * Register bundled sources, supplying crash ownership only to command execution.
 * @internal
 */
export function registerCoreSources(
  registry: SourceRegistry,
  commandOwner?: CommandProcessOwner,
  shutdownSignal?: AbortSignal,
): void {
  registry.register(fileFingerprint);
  registry.register(apiPoll);
  registry.register(createCommandPollSource(commandOwner, shutdownSignal));
  registry.register(schedule);
  registry.register(incomingChanges);
}
