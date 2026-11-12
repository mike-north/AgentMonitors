/**
 * `agentmonitors monitor retry rearm|skip` (005 `monitor retry`): the operator
 * repairs for a terminal materialization retry, the retained work that keeps
 * its monitor from taking newer input (002 §2.7). A retry is named exactly as
 * `monitor explain` and `doctor` list it: its monitor id and record id.
 *
 * Both commands go to the workspace's live daemon when one is reachable, so a
 * watcher paused on the retry there wakes at once, and otherwise apply the
 * same core transaction to the workspace's persisted store. The core decides
 * what each repair does and refuses; this module only routes and renders.
 */
import path from 'node:path';
import { Command, Option } from 'commander';
import type { MaterializationRetryDiagnostic } from '@agentmonitors/core';
import { reportError } from '../output.js';
import { renderToon, resolveFormat } from '../toon-format.js';
import { DaemonConnectionError } from '../daemon-ipc.js';
import { resolveManualDaemonSocketPath } from '../manual-daemon.js';
import { readLocalState } from '../local-state.js';
import { resolveWorkspaceDbPath } from '../workspace-db-path.js';
import {
  rearmRetryClient,
  rearmRetryInProcess,
  skipRetryClient,
  skipRetryInProcess,
} from '../runtime-client.js';

/** Shown when a repair was applied to the persisted store because no daemon answered. */
const NO_DAEMON_NOTICE =
  'No daemon running — applied to the persisted store; it takes effect on the next tick.';

/** The two repairs, with how each is reported. */
type RetryRepair = 'rearm' | 'skip';

interface RetryRepairOptions {
  workspace?: string;
  socket?: string;
  reason?: string;
  format: string | undefined;
}

/** Where a repair was applied: the live daemon, or the store directly. */
type AppliedVia = 'daemon' | 'in-process';

function successLines(
  repair: RetryRepair,
  monitorId: string,
  retry: MaterializationRetryDiagnostic,
): string[] {
  if (repair === 'rearm') {
    return [
      `Re-armed retry ${retry.id} of monitor ${monitorId}: its failed attempts are reset and it is next attempted at ${retry.nextAttemptAt?.toISOString() ?? 'the next tick'}.`,
      'The monitor stays paused until this retry completes, then takes newer input in order.',
    ];
  }
  return [
    `Skipped retry ${retry.id} of monitor ${monitorId}. Its observation is recorded as an outstanding loss until a later event for the same object supersedes it; see \`agentmonitors monitor explain ${monitorId}\`.`,
    'The monitor takes newer input on its next tick unless other retained work is still ahead of it.',
  ];
}

async function runRepair(
  repair: RetryRepair,
  monitorId: string,
  retryId: string,
  options: RetryRepairOptions,
): Promise<void> {
  const format = resolveFormat(options.format);
  const json = format === 'json';
  const workspacePath = path.resolve(options.workspace ?? process.cwd());
  // The same per-workspace socket `monitor explain`/`doctor` resolve.
  const socketPath = resolveManualDaemonSocketPath(
    options.socket,
    workspacePath,
  );
  const input = {
    monitorId,
    retryId,
    workspacePath,
    ...(repair === 'skip' && options.reason !== undefined
      ? { reason: options.reason }
      : {}),
  };
  const label = repair === 'rearm' ? 'Re-arm' : 'Skip';
  let retry: MaterializationRetryDiagnostic;
  let via: AppliedVia = 'daemon';
  try {
    try {
      retry =
        repair === 'rearm'
          ? await rearmRetryClient(input, socketPath)
          : await skipRetryClient(input, socketPath);
    } catch (error) {
      // Only an unreachable daemon falls back; a refusal from a live daemon
      // is the answer, not a reason to write the store behind its back.
      if (!(error instanceof DaemonConnectionError)) throw error;
      via = 'in-process';
      const dbPath = resolveWorkspaceDbPath(
        workspacePath,
        readLocalState(workspacePath),
      );
      retry =
        repair === 'rearm'
          ? rearmRetryInProcess(input, dbPath)
          : skipRetryInProcess(input, dbPath);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportError(
      `${label} failed for retry ${retryId} of monitor ${monitorId} in workspace ${workspacePath}: ${message}`,
      json,
    );
    return;
  }

  const result = {
    action: repair,
    monitorId,
    workspacePath,
    via,
    retry,
  };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (format === 'toon') {
    console.log(renderToon(result));
    return;
  }
  if (via === 'in-process') console.log(NO_DAEMON_NOTICE);
  for (const line of successLines(repair, monitorId, retry)) console.log(line);
}

function formatOption(): Option {
  return new Option('--format <format>', 'Output format')
    .choices(['toon', 'json', 'text'])
    .default(undefined, 'auto (toon for agents, text for humans)');
}

export const monitorRetryCommand = new Command('retry').description(
  'Repair a terminal materialization retry that keeps its monitor paused',
);

monitorRetryCommand
  .command('rearm')
  .description(
    'Attempt a terminal retry again: reset its failed attempts so it is retried automatically',
  )
  .argument('<monitorId>', 'Monitor whose retry outbox holds the retry')
  .argument(
    '<retryId>',
    'Retry record id, as `monitor explain` and `doctor` list it',
  )
  .option('--workspace <path>', 'Workspace path used by the daemon')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(formatOption())
  .action(
    async (monitorId: string, retryId: string, options: RetryRepairOptions) =>
      runRepair('rearm', monitorId, retryId, options),
  );

monitorRetryCommand
  .command('skip')
  .description(
    'Give up a terminal retry: record its observation as an outstanding loss and let the monitor take newer input',
  )
  .argument('<monitorId>', 'Monitor whose retry outbox holds the retry')
  .argument(
    '<retryId>',
    'Retry record id, as `monitor explain` and `doctor` list it',
  )
  .option(
    '--reason <text>',
    'Why the observation is given up (recorded with the loss)',
  )
  .option('--workspace <path>', 'Workspace path used by the daemon')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(formatOption())
  .action(
    async (monitorId: string, retryId: string, options: RetryRepairOptions) =>
      runRepair('skip', monitorId, retryId, options),
  );
