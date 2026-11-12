/**
 * `agentmonitors monitor retry rearm|skip` (005 `monitor retry`): the operator
 * repairs for a terminal materialization retry, the retained work that keeps
 * its monitor from taking newer input (002 §2.7). A retry is named exactly as
 * `monitor explain` and `doctor` list it: its monitor id and record id.
 *
 * Both commands go to the workspace's live daemon when one is reachable, so a
 * watcher paused on the retry there wakes at once. Only when no daemon
 * accepted the connection do they apply the same core transaction to the
 * workspace's persisted store. Once a daemon has the request, a missing reply
 * is reported as an unknown outcome and the store is never written from here:
 * the daemon may already have applied the repair. The core decides what each
 * repair does and refuses; this module only routes and renders.
 */
import path from 'node:path';
import { Command, Option } from 'commander';
import {
  MATERIALIZATION_RETRY_SKIP_REASON_MAX_LENGTH,
  type MaterializationRetryRepairResult,
} from '@agentmonitors/core';
import { reportError } from '../output.js';
import { renderToon, resolveFormat } from '../toon-format.js';
import { DaemonConnectionError } from '../daemon-ipc.js';
import { resolveManualDaemonSocketPath } from '../manual-daemon.js';
import { readLocalState } from '../local-state.js';
import { resolveWorkspaceDbPath } from '../workspace-db-path.js';
import {
  doctorCommandLine,
  explainCommand,
  workspaceMonitorsDir,
  type SuggestionScope,
} from '../suggested-commands.js';
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

/**
 * The workspace the repair was applied in, with that workspace's own monitor
 * definitions: the repairs take no `--dir`, so a suggested `explain` or
 * `doctor` reads the definitions where the workspace keeps them.
 */
function suggestionScope(workspacePath: string): SuggestionScope {
  return { workspacePath, monitorsDir: workspaceMonitorsDir(workspacePath) };
}

/**
 * The report for a request a daemon accepted but never answered (a timeout,
 * or the connection dropping after the request was written). The daemon may
 * have applied the repair, so the CLI neither claims an outcome nor applies it
 * itself; it points at the read-only commands that show which it was.
 */
function outcomeUnknownMessage(
  repair: RetryRepair,
  monitorId: string,
  retryId: string,
  workspacePath: string,
  error: DaemonConnectionError,
): string {
  const label = repair === 'rearm' ? 'Re-arm' : 'Skip';
  const noun = repair === 'rearm' ? 're-arm' : 'skip';
  const scope = suggestionScope(workspacePath);
  return `${label} outcome unknown for retry ${retryId} of monitor ${monitorId} in workspace ${workspacePath}: the daemon received the request but no reply arrived (${error.message}). The ${noun} may already have been applied; nothing was written to the store from here. Check with \`${explainCommand(scope, monitorId)}\` or \`${doctorCommandLine(scope)}\` before running it again.`;
}

/** Shown once a removed retry no longer holds its monitor back. */
const RESUMES_LINE =
  'The monitor takes newer input on its next tick unless other retained work is still ahead of it.';

function successLines(
  monitorId: string,
  workspacePath: string,
  { outcome, retry }: MaterializationRetryRepairResult,
): string[] {
  if (outcome === 'verify-artifact-cleanup') {
    // 002 §2.8: either repair removes a retired verify artifact's retry as
    // the cleanup its owner asked for; it is neither re-armed nor a loss.
    return [
      `Removed retry ${retry.id} of monitor ${monitorId} as verify-artifact cleanup: its observation is a verify scratch artifact whose cleanup has taken effect, so it is neither re-armed nor recorded as a loss.`,
      RESUMES_LINE,
    ];
  }
  if (outcome === 'rearmed') {
    return [
      `Re-armed retry ${retry.id} of monitor ${monitorId}: its failed attempts are reset and it is next attempted at ${retry.nextAttemptAt?.toISOString() ?? 'the next tick'}.`,
      'The monitor stays paused until this retry completes, then takes newer input in order.',
    ];
  }
  return [
    `Skipped retry ${retry.id} of monitor ${monitorId}. Its observation is recorded as an outstanding loss until a later event for the same object supersedes it; see \`${explainCommand(suggestionScope(workspacePath), monitorId)}\`.`,
    RESUMES_LINE,
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
  let repaired: MaterializationRetryRepairResult;
  let via: AppliedVia = 'daemon';
  try {
    try {
      repaired =
        repair === 'rearm'
          ? await rearmRetryClient(input, socketPath)
          : await skipRetryClient(input, socketPath);
    } catch (error) {
      // Only a daemon that never accepted the request falls back; a refusal
      // from a live daemon is the answer, not a reason to write the store
      // behind its back.
      if (!(error instanceof DaemonConnectionError)) throw error;
      if (error.requestSent) {
        reportError(
          outcomeUnknownMessage(
            repair,
            monitorId,
            retryId,
            workspacePath,
            error,
          ),
          json,
        );
        return;
      }
      via = 'in-process';
      const dbPath = resolveWorkspaceDbPath(
        workspacePath,
        readLocalState(workspacePath),
      );
      repaired =
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
    outcome: repaired.outcome,
    monitorId,
    workspacePath,
    via,
    retry: repaired.retry,
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
  for (const line of successLines(monitorId, workspacePath, repaired)) {
    console.log(line);
  }
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
    `Why the observation is given up (recorded with the loss; at most ${String(MATERIALIZATION_RETRY_SKIP_REASON_MAX_LENGTH)} characters)`,
  )
  .option('--workspace <path>', 'Workspace path used by the daemon')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .addOption(formatOption())
  .action(
    async (monitorId: string, retryId: string, options: RetryRepairOptions) =>
      runRepair('skip', monitorId, retryId, options),
  );
