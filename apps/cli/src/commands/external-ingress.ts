import path from 'node:path';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { Command, Option } from 'commander';
import {
  ExternalEventIngestError,
  validateExternalEventEnvelope,
  type ExternalEventEnvelope,
  type ExternalEventIngestResult,
  type ExternalEventReceiptRecord,
} from '@agentmonitors/core';
import {
  DaemonApplicationError,
  DaemonConnectionError,
  DaemonUnsupportedRequestError,
} from '../daemon-ipc.js';
import {
  manualDaemonErrorMessage,
  resolveManualDaemonSocketPath,
} from '../manual-daemon.js';
import {
  daemonStatusClient,
  externalEventReceiptStatusClient,
  ingestExternalEventClient,
  rearmExternalEventReceiptClient,
  rearmMaterializationRetryClient,
  type ExternalDaemonRouting,
  type SafeMaterializationRetry,
} from '../runtime-client.js';
import { singleLineSafe } from './events.js';

type ExternalOutputFormat = 'text' | 'json';

interface ExternalRoutingOptions {
  workspace: string;
  dir?: string;
  socket?: string;
  format: ExternalOutputFormat;
}

interface ResolvedExternalRouting {
  routing: ExternalDaemonRouting;
  socketPath?: string;
}

interface ExternalCommandError {
  code: string;
  message: string;
  retryable: boolean;
}

function localError(
  code: ConstructorParameters<typeof ExternalEventIngestError>[0],
  message: string,
): ExternalEventIngestError {
  return new ExternalEventIngestError(code, message, false);
}

export function parseEnvelope(filePath?: string): ExternalEventEnvelope {
  let raw: string;
  try {
    raw = readFileSync(!filePath || filePath === '-' ? 0 : filePath, 'utf8');
  } catch {
    throw localError(
      'invalid_envelope',
      'Unable to read one JSON event envelope from the requested input.',
    );
  }
  if (raw.trim().length === 0) {
    throw localError('invalid_envelope', 'Event envelope input is empty.');
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw localError(
      'invalid_envelope',
      'Event envelope input must contain exactly one JSON value.',
    );
  }
  const validation = validateExternalEventEnvelope(input);
  if (!validation.success) {
    throw new ExternalEventIngestError(
      validation.error.code,
      validation.error.message,
      validation.error.retryable,
    );
  }
  return validation.envelope;
}

function pathIdentities(input: string, required: boolean): Set<string> {
  const resolved = path.resolve(input);
  const identities = new Set([resolved]);
  try {
    const canonical = realpathSync(resolved);
    if (required && !statSync(canonical).isDirectory()) {
      throw new Error('not a directory');
    }
    identities.add(canonical);
  } catch {
    if (required) {
      throw localError(
        'workspace_mismatch',
        'Workspace must be an existing local directory.',
      );
    }
  }
  return identities;
}

async function resolveExternalRouting(
  options: ExternalRoutingOptions,
): Promise<ResolvedExternalRouting> {
  const workspace = path.resolve(options.workspace);
  const monitorsDir = options.dir
    ? path.resolve(options.dir)
    : path.join(workspace, '.claude', 'monitors');
  const workspaceIdentities = pathIdentities(workspace, true);
  const monitorsDirIdentities = pathIdentities(monitorsDir, false);
  const socketPath = resolveManualDaemonSocketPath(options.socket, workspace);
  const status = await daemonStatusClient(socketPath);
  if (!status.workspaceIdentity || !status.monitorsDirIdentity) {
    throw new DaemonUnsupportedRequestError(
      'The running AgentMon daemon does not expose external-ingress identities; upgrade and restart it.',
    );
  }
  if (
    !workspaceIdentities.has(status.workspaceIdentity) ||
    !monitorsDirIdentities.has(status.monitorsDirIdentity)
  ) {
    throw localError(
      'workspace_mismatch',
      'The requested workspace or monitor directory does not match the serving daemon.',
    );
  }
  return {
    routing: {
      workspaceIdentity: status.workspaceIdentity,
      monitorsDirIdentity: status.monitorsDirIdentity,
    },
    ...(socketPath ? { socketPath } : {}),
  };
}

export function classifyError(error: unknown): ExternalCommandError {
  if (
    error instanceof ExternalEventIngestError ||
    error instanceof DaemonApplicationError ||
    error instanceof DaemonConnectionError ||
    error instanceof DaemonUnsupportedRequestError
  ) {
    return {
      code: error.code,
      message:
        error instanceof DaemonConnectionError
          ? manualDaemonErrorMessage(error)
          : error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: 'internal_error',
    message: 'External event command failed unexpectedly.',
    retryable: true,
  };
}

function reportExternalError(
  error: unknown,
  format: ExternalOutputFormat,
): void {
  const safe = classifyError(error);
  if (format === 'json') {
    console.log(JSON.stringify({ error: safe }, null, 2));
  } else {
    console.error(`Error [${safe.code}]: ${safe.message}`);
  }
  process.exitCode = 1;
}

function printIngestResult(
  result: ExternalEventIngestResult,
  format: ExternalOutputFormat,
): void {
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `${result.disposition}: ${singleLineSafe(result.monitorId)} ${result.outcome} (receipt ${singleLineSafe(result.receiptId)}, ${String(result.eventIds.length)} event(s))`,
  );
}

function printReceipt(
  receipt: ExternalEventReceiptRecord | null,
  format: ExternalOutputFormat,
): void {
  if (format === 'json') {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  if (!receipt) {
    console.log('Receipt not found.');
    return;
  }
  console.log(
    `Receipt ${singleLineSafe(receipt.receiptId)}: ${receipt.outcome}; ${String(receipt.attemptCount)} attempt(s); ${String(receipt.eventIds.length)} event(s).`,
  );
}

function printRetry(
  retry: SafeMaterializationRetry,
  format: ExternalOutputFormat,
): void {
  if (format === 'json') {
    console.log(JSON.stringify(retry, null, 2));
    return;
  }
  console.log(
    `Re-armed retry ${singleLineSafe(retry.id)} for ${singleLineSafe(retry.monitorId)}; status ${retry.status}.`,
  );
}

function addRoutingOptions(command: Command): Command {
  return command
    .option(
      '--workspace <path>',
      'Local workspace (defaults to the current working directory)',
      process.cwd(),
    )
    .option(
      '--dir <path>',
      'Expected monitor directory (defaults to <workspace>/.claude/monitors)',
    )
    .option('--socket <path>', 'Unix domain socket path for the daemon')
    .addOption(
      new Option('--format <format>', 'Output format')
        .choices(['text', 'json'])
        .default('text'),
    );
}

export function registerExternalIngressCommands(
  eventsCommand: Command,
  monitorCommand: Command,
): void {
  addRoutingOptions(
    eventsCommand
      .command('ingest')
      .description('Durably ingest one external current-state event')
      .option(
        '--file <path>',
        'Read one JSON envelope from a file; use - or omit for stdin',
      ),
  ).action(async (options: ExternalRoutingOptions & { file?: string }) => {
    try {
      const envelope = parseEnvelope(options.file);
      const resolved = await resolveExternalRouting(options);
      printIngestResult(
        await ingestExternalEventClient(
          resolved.routing,
          envelope,
          resolved.socketPath,
        ),
        options.format,
      );
    } catch (error) {
      reportExternalError(error, options.format);
    }
  });

  addRoutingOptions(
    eventsCommand
      .command('ingest-status')
      .description('Show safe external-ingress receipt metadata')
      .requiredOption('--receipt <id>', 'External-ingress receipt id'),
  ).action(async (options: ExternalRoutingOptions & { receipt: string }) => {
    try {
      const resolved = await resolveExternalRouting(options);
      printReceipt(
        await externalEventReceiptStatusClient(
          resolved.routing,
          options.receipt,
          resolved.socketPath,
        ),
        options.format,
      );
    } catch (error) {
      reportExternalError(error, options.format);
    }
  });

  addRoutingOptions(
    eventsCommand
      .command('ingest-retry')
      .description('Operator action: re-arm a terminal external receipt')
      .requiredOption('--receipt <id>', 'External-ingress receipt id'),
  ).action(async (options: ExternalRoutingOptions & { receipt: string }) => {
    try {
      const resolved = await resolveExternalRouting(options);
      printReceipt(
        await rearmExternalEventReceiptClient(
          resolved.routing,
          options.receipt,
          resolved.socketPath,
        ),
        options.format,
      );
    } catch (error) {
      reportExternalError(error, options.format);
    }
  });

  addRoutingOptions(
    monitorCommand
      .command('retry-outbox')
      .description('Operator action: re-arm a terminal materialization retry')
      .requiredOption('--retry <id>', 'Materialization retry record id'),
  ).action(async (options: ExternalRoutingOptions & { retry: string }) => {
    try {
      const resolved = await resolveExternalRouting(options);
      printRetry(
        await rearmMaterializationRetryClient(
          resolved.routing,
          options.retry,
          resolved.socketPath,
        ),
        options.format,
      );
    } catch (error) {
      reportExternalError(error, options.format);
    }
  });
}
