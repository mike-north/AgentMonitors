import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { Command, Option } from 'commander';
import {
  parseMonitor,
  scanMonitors,
  SourceRegistry,
  validateScope,
  type MonitorExplainReport,
  type MonitorExplainStage,
  type MonitorExplainStageId,
  type MonitorExplainStageStatus,
  type ObservationContext,
  type ObservationSource,
  type Observation,
} from '@agentmonitors/core';
import { registerCoreSources } from '../sources.js';
import { reportError } from '../output.js';
import { DaemonConnectionError } from '../daemon-ipc.js';
import {
  explainMonitorClient,
  listObservationHistoryClient,
} from '../runtime-client.js';

export const monitorTestCommand = new Command('monitor').description(
  'Monitor utilities',
);

const EXPLAIN_STAGE_LABELS: Record<MonitorExplainStageId, string> = {
  definition: 'Definition',
  scheduling: 'Scheduling',
  observation: 'Observation',
  notify: 'Notify state',
  materialization: 'Materialization',
  delivery: 'Projection and delivery',
};

function monitorIdFromFilePath(filePath: string): string {
  const base = path.basename(filePath);
  return base === 'MONITOR.md'
    ? path.basename(path.dirname(filePath))
    : path.parse(filePath).name;
}

function explainStage(
  id: MonitorExplainStageId,
  status: MonitorExplainStageStatus,
  reason: string,
  details?: Record<string, unknown>,
): MonitorExplainStage {
  return {
    id,
    label: EXPLAIN_STAGE_LABELS[id],
    status,
    reason,
    ...(details ? { details } : {}),
  };
}

function explainVerdict(stages: MonitorExplainStage[]) {
  const stopped = stages.find((stage) => stage.status !== 'ok');
  const stage = stopped ?? stages[stages.length - 1];
  return {
    status: stage?.status ?? 'ok',
    stage: stage?.id ?? 'delivery',
    reason: stage?.reason ?? 'Monitor delivered successfully.',
  };
}

function statusGlyph(status: MonitorExplainStageStatus): string {
  if (status === 'ok') return '✓';
  if (status === 'pending') return '⏳';
  // A healthy/idle stage (e.g. the watched target genuinely hasn't changed,
  // issue #94) is rendered distinctly from both delivered (✓) and failure (✗).
  if (status === 'healthy') return '○';
  return '✗';
}

function printExplainText(report: MonitorExplainReport): void {
  console.log(`Monitor ${report.monitorId}`);
  for (const stage of report.stages) {
    console.log(`${statusGlyph(stage.status)} ${stage.label}: ${stage.reason}`);
  }
  console.log(
    `Verdict: ${report.verdict.status} at ${EXPLAIN_STAGE_LABELS[report.verdict.stage]} - ${report.verdict.reason}`,
  );
}

async function buildDaemonUnavailableReport(input: {
  monitorId: string;
  monitorsDir: string;
  workspacePath?: string;
  errorMessage: string;
}): Promise<MonitorExplainReport> {
  const generatedAt = new Date();
  const stages: MonitorExplainStage[] = [];
  const scan = await scanMonitors(input.monitorsDir);
  const parseError = scan.errors.find(
    (error) => monitorIdFromFilePath(error.filePath) === input.monitorId,
  );
  const monitor = scan.monitors.find(
    (candidate) => candidate.monitor.id === input.monitorId,
  )?.monitor;

  if (parseError) {
    stages.push(
      explainStage(
        'definition',
        'failure',
        `MONITOR.md failed to parse or validate: ${parseError.error}`,
        { filePath: parseError.filePath },
      ),
    );
  } else if (!monitor) {
    stages.push(
      explainStage(
        'definition',
        'failure',
        `Monitor "${input.monitorId}" was not found in ${input.monitorsDir}.`,
      ),
    );
  } else {
    const registry = new SourceRegistry();
    registerCoreSources(registry);
    const sourceName = monitor.frontmatter.watch.type;
    const source = registry.get(sourceName);
    const { type: _type, ...monitorWatchConfig } = monitor.frontmatter.watch;
    const scopeErrors = source
      ? validateScope(monitorWatchConfig, source.scopeSchema)
      : [`Unknown source "${sourceName}".`];
    stages.push(
      scopeErrors.length === 0
        ? explainStage('definition', 'ok', 'Monitor definition is valid.', {
            filePath: monitor.filePath,
            sourceName,
          })
        : explainStage(
            'definition',
            'failure',
            `Monitor definition is invalid: ${scopeErrors.join('; ')}`,
            { filePath: monitor.filePath, sourceName },
          ),
    );
  }

  if (stages[0]?.status === 'ok') {
    stages.push(
      explainStage(
        'scheduling',
        'failure',
        `The daemon is not running or unreachable: ${input.errorMessage}`,
        { workspacePath: input.workspacePath },
      ),
    );
  }

  return {
    monitorId: input.monitorId,
    generatedAt,
    ...(monitor
      ? {
          monitor: {
            id: monitor.id,
            displayName: monitor.displayName,
            filePath: monitor.filePath,
            sourceName: monitor.frontmatter.watch.type,
            urgency: monitor.frontmatter.urgency,
          },
        }
      : {}),
    stages,
    verdict: explainVerdict(stages),
    observations: [],
    events: [],
    projections: [],
    leadSessions: [],
  };
}

/** Format observations as JSON output. */
function printJsonResult(
  monitorName: string,
  sourceName: string,
  baseline: boolean,
  observations: Observation[],
): void {
  console.log(
    JSON.stringify(
      {
        monitor: monitorName,
        source: sourceName,
        baseline,
        observations: observations.map((o) => ({
          title: o.title,
          snapshot: o.snapshot,
        })),
      },
      null,
      2,
    ),
  );
}

/** Print observations in human-readable text format. */
function printTextObservations(observations: Observation[]): void {
  console.log(`${String(observations.length)} observation(s):\n`);
  for (const obs of observations) {
    console.log(`  Title: ${obs.title}`);
    console.log(`  Snapshot: ${JSON.stringify(obs.snapshot, null, 2)}`);
    console.log('');
  }
}

const SOURCE_TEST_MESSAGES: Record<string, string[]> = {
  'file-fingerprint': [
    'In production, the agent process keeps running between observations, so file changes are detected across polls.',
    'This test command verifies that the source can read and fingerprint your files successfully.',
  ],
  'api-poll': [
    'In production, the agent process keeps running between observations, so API response changes are detected across polls.',
    'This test command verifies that the source can reach your API endpoint successfully.',
  ],
};

const DEFAULT_TEST_MESSAGES = [
  'In production, the agent process keeps running between observations, so changes are detected across polls.',
  'This test command verifies that the source is configured correctly.',
];

export function createFollowupObservationContext(
  context: ObservationContext,
): ObservationContext {
  return {
    now: new Date(),
    previousState: context.previousState,
  };
}

/** Handle the baseline-then-detect flow for stateful sources. */
async function handleStatefulSource(
  source: ObservationSource,
  scope: Record<string, unknown>,
  monitorName: string,
  json: boolean,
  context: ObservationContext,
): Promise<void> {
  if (!json) {
    console.log(
      `\nBaseline established. The "${source.name}" source requires a prior baseline before it can detect changes.`,
    );
    console.log(
      'Running a second observation to demonstrate change detection...\n',
    );
  }

  await setTimeout(100);
  const secondResult = await source.observe(
    scope,
    createFollowupObservationContext(context),
  );
  const secondObservations = secondResult.observations;

  if (json) {
    printJsonResult(monitorName, source.name, true, secondObservations);
    return;
  }

  if (secondObservations.length > 0) {
    printTextObservations(secondObservations);
    return;
  }

  console.log(
    'No changes detected since baseline. This is expected — both observations happened within the same command invocation.',
  );
  const messages = SOURCE_TEST_MESSAGES[source.name] ?? DEFAULT_TEST_MESSAGES;
  for (const msg of messages) {
    console.log(`\n${msg}`);
  }
}

monitorTestCommand
  .command('test')
  .description('Dry-run a monitor observation source')
  .argument('<path>', 'Path to MONITOR.md file')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(async (filePath: string, options: { format: string }) => {
    const json = options.format === 'json';

    if (!existsSync(filePath)) {
      reportError(`Monitor file not found: ${filePath}`, json);
      return;
    }

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reportError(`Cannot read monitor file: ${msg}`, json);
      return;
    }

    const result = parseMonitor(content, filePath);

    if (!result.ok) {
      reportError(`Parse error: ${result.error}`, json);
      return;
    }

    const registry = new SourceRegistry();
    registerCoreSources(registry);

    const source = registry.get(result.monitor.frontmatter.watch.type);
    if (!source) {
      reportError(
        `Unknown source: "${result.monitor.frontmatter.watch.type}". Available: ${registry.names().join(', ')}`,
        json,
      );
      return;
    }

    const monitorName = result.monitor.displayName;

    // Extract per-source config (watch block minus `type`)
    const { type: _type, ...monitorWatchConfig } =
      result.monitor.frontmatter.watch;

    if (!json) {
      console.log(
        `Testing monitor "${monitorName}" (source: ${source.name})...`,
      );
    }

    try {
      let context: ObservationContext = { now: new Date() };
      const firstResult = await source.observe(monitorWatchConfig, context);
      const observations = firstResult.observations;
      context = {
        now: new Date(),
        previousState: firstResult.nextState,
      };

      if (observations.length === 0 && source.stateful) {
        await handleStatefulSource(
          source,
          monitorWatchConfig,
          monitorName,
          json,
          context,
        );
      } else if (json) {
        printJsonResult(monitorName, source.name, false, observations);
      } else if (observations.length === 0) {
        console.log('No observations produced.');
      } else {
        printTextObservations(observations);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reportError(`Observation failed: ${message}`, json);
    }
  });

monitorTestCommand
  .command('explain')
  .description("Explain where a monitor's signal currently stops")
  .argument('<monitorId>', 'Monitor id to diagnose')
  .option(
    '--dir <path>',
    'Directory containing monitor definitions',
    '.claude/monitors',
  )
  .option('--workspace <path>', 'Workspace path used by the daemon')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .option('--history-limit <n>', 'Observation history rows to include', '10')
  .option('--event-limit <n>', 'Materialized event rows to include', '10')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(
    async (
      monitorId: string,
      options: {
        dir: string;
        workspace?: string;
        socket?: string;
        historyLimit: string;
        eventLimit: string;
        format: string;
      },
    ) => {
      const json = options.format === 'json';
      const monitorsDir = path.resolve(options.dir);
      const workspacePath = path.resolve(options.workspace ?? process.cwd());
      const historyLimit = Number.parseInt(options.historyLimit, 10);
      const eventLimit = Number.parseInt(options.eventLimit, 10);
      try {
        const report = await explainMonitorClient(
          {
            monitorId,
            monitorsDir,
            workspacePath,
            ...(Number.isFinite(historyLimit) && historyLimit > 0
              ? { historyLimit }
              : {}),
            ...(Number.isFinite(eventLimit) && eventLimit > 0
              ? { eventLimit }
              : {}),
          },
          options.socket,
        );

        if (json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        printExplainText(report);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Only fall back to the "daemon unavailable" diagnosis when the daemon
        // was genuinely unreachable (connection refused / no socket / timeout).
        // A daemon-side application error (e.g. an explain failure or a method
        // error) must be surfaced verbatim — masking it as "daemon not running"
        // hides the real failure (issue #94 review, comment 3408123745).
        if (!(err instanceof DaemonConnectionError)) {
          reportError(`Explain failed: ${message}`, json);
          return;
        }
        const report = await buildDaemonUnavailableReport({
          monitorId,
          monitorsDir,
          workspacePath,
          errorMessage: message,
        });
        if (json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        printExplainText(report);
      }
    },
  );

monitorTestCommand
  .command('history')
  .description(
    'Show recent observation outcomes per tick (triggered / suppressed / no-change / errored / rebaselined)',
  )
  .argument('[monitorId]', 'Filter to a single monitor id')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .option('--limit <n>', 'Maximum rows to return', '50')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['text', 'json'])
      .default('text'),
  )
  .action(
    async (
      monitorId: string | undefined,
      options: { socket?: string; limit: string; format: string },
    ) => {
      const json = options.format === 'json';
      try {
        const limit = Number.parseInt(options.limit, 10);
        const records = await listObservationHistoryClient(
          {
            ...(monitorId ? { monitorId } : {}),
            ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
          },
          options.socket,
        );

        if (json) {
          console.log(JSON.stringify(records, null, 2));
          return;
        }
        if (records.length === 0) {
          console.log('No observation history.');
          return;
        }
        for (const record of records) {
          console.log(
            `${String(record.createdAt)}  ${record.result.padEnd(10)}  ${record.monitorId}  (${record.sourceName})`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportError(`History failed: ${message}`, json);
      }
    },
  );
