import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { Command, Option } from 'commander';
import {
  parseMonitor,
  SourceRegistry,
  type MonitorExplainReport,
  type MonitorExplainStageId,
  type MonitorExplainStageStatus,
  type ObservationContext,
  type ObservationResult,
  type ObservationSource,
  type Observation,
} from '@agentmonitors/core';
import { registerCoreSources } from '../sources.js';
import { reportError } from '../output.js';
import { renderToon, resolveFormat } from '../toon-format.js';
import { DaemonConnectionError, resolveSocketPath } from '../daemon-ipc.js';
import {
  explainMonitorClient,
  explainMonitorInProcess,
  listObservationHistoryClient,
  listObservationHistoryInProcess,
} from '../runtime-client.js';

/**
 * Banner shown when `monitor explain` / `monitor history` fall back to reading
 * the persisted SQLite store because no daemon is reachable. Issue #150.
 */
const NO_DAEMON_BANNER =
  'No daemon running — showing persisted state from the last tick.';

/**
 * Actionable remediation shown when the daemon is down AND there is genuinely
 * nothing persisted to read (no DB rows for the monitor). Replaces the raw Node
 * `connect ENOENT …` error, which gave the author no next step. Issue #150,
 * PM decision (b)(i).
 */
const NO_DAEMON_REMEDIATION =
  'No daemon running and no persisted state to show. Start it with `agentmonitors daemon run`, or use `agentmonitors monitor test <path>` for a one-shot check.';

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

/** Format observations as JSON output. */
function printJsonResult(
  monitorName: string,
  sourceName: string,
  baseline: boolean,
  observations: Observation[],
  warnings: string[] = [],
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
        // Only present non-empty warnings so unaffected monitors keep a clean
        // JSON shape; consumers treat absence as "no warnings".
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      null,
      2,
    ),
  );
}

/**
 * Print non-fatal source warnings (003 §4.2, issue #219) to stderr so a `monitor
 * test` dry-run surfaces likely misconfigurations (e.g. json-diff on an HTML
 * page) without masking them as success. Text output only; JSON callers embed
 * warnings in the payload.
 */
function printWarnings(warnings: string[] | undefined): void {
  if (!warnings) return;
  for (const warning of warnings) {
    console.error(`Warning: ${warning}`);
  }
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
    ...(context.workspacePath !== undefined
      ? { workspacePath: context.workspacePath }
      : {}),
  };
}

/**
 * Resolve the project config root for a MONITOR.md path. Project monitors live
 * under `<root>/.claude/monitors/...` or `<root>/.codex/monitors/...`; source
 * dry-runs need that root so relative file globs do not depend on process cwd.
 */
type ConfigRootPathApi = Pick<typeof path, 'dirname' | 'resolve' | 'sep'>;

export function configRootForMonitorFile(
  filePath: string,
  pathApi: ConfigRootPathApi = path,
): string {
  const resolvedPath = pathApi.resolve(filePath);
  const segments = resolvedPath.split(pathApi.sep);
  let configDirIndex = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === '.claude' || segment === '.codex') {
      configDirIndex = index;
      break;
    }
  }
  if (configDirIndex > 0) {
    // Build the concrete `.claude`/`.codex` directory and ask the path module
    // for its parent. Joining only the parent segments turns `C:\` into `C:`
    // on Windows drive-root projects, which is not an absolute Node path.
    return pathApi.dirname(
      segments.slice(0, configDirIndex + 1).join(pathApi.sep),
    );
  }
  return pathApi.dirname(resolvedPath);
}

function reportNoFilesMatched(
  monitorName: string,
  sourceName: string,
  workspacePath: string,
  json: boolean,
): void {
  const message = `No files matched this monitor's globs. Check watch.globs and watch.cwd relative to workspace: ${workspacePath}`;
  if (json) {
    console.log(
      JSON.stringify(
        {
          monitor: monitorName,
          source: sourceName,
          baseline: false,
          outcome: 'no-files-matched' satisfies ObservationResult['outcome'],
          observations: [],
          error: message,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`Error: ${message}`);
  }
  process.exitCode = 1;
}

/**
 * For api-poll sources, extract and print the HTTP status and response body size
 * from the baseline state so authors can immediately spot bad URLs (e.g. a 404
 * or an error body) that would silently baseline as "success". Issue #153.
 */
function printApiPollBaselineSummary(
  baselineState: unknown,
  json: boolean,
): void {
  if (json) return; // JSON output is handled by the caller via printJsonResult
  if (
    baselineState === null ||
    typeof baselineState !== 'object' ||
    Array.isArray(baselineState)
  )
    return;
  const state = baselineState as Record<string, unknown>;
  const status = typeof state['status'] === 'number' ? state['status'] : null;
  const body = typeof state['body'] === 'string' ? state['body'] : null;
  if (status === null) return;
  // Use Buffer.byteLength for the UTF-8 byte count, not body.length (which is
  // UTF-16 code units and would undercount multi-byte characters). Issue #153.
  const sizeStr =
    body !== null ? ` (${String(Buffer.byteLength(body, 'utf8'))} bytes)` : '';
  console.log(`  HTTP ${String(status)}${sizeStr}`);
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
    // For api-poll, show the HTTP status and response size from the baseline
    // so authors can spot bad URLs before they silently baseline on error
    // responses. Issue #153 (item 5).
    if (source.name === 'api-poll') {
      printApiPollBaselineSummary(context.previousState, json);
    }
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
    printJsonResult(
      monitorName,
      source.name,
      true,
      secondObservations,
      secondResult.warnings ?? [],
    );
    return;
  }

  // Surface non-fatal source warnings (e.g. json-diff against a non-JSON body,
  // issue #219) before the change-detection summary so the author sees them.
  printWarnings(secondResult.warnings);

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
      const workspacePath = configRootForMonitorFile(filePath);
      let context: ObservationContext = { now: new Date(), workspacePath };
      const firstResult = await source.observe(monitorWatchConfig, context);
      const observations = firstResult.observations;
      context = {
        now: new Date(),
        previousState: firstResult.nextState,
        workspacePath,
      };

      if (firstResult.outcome === 'no-files-matched') {
        // A zero-match scope is an authoring diagnostic, not a valid baseline;
        // stop here so text and JSON output cannot imply quiet success.
        reportNoFilesMatched(monitorName, source.name, workspacePath, json);
      } else if (observations.length === 0 && source.stateful) {
        await handleStatefulSource(
          source,
          monitorWatchConfig,
          monitorName,
          json,
          context,
        );
      } else if (json) {
        printJsonResult(
          monitorName,
          source.name,
          false,
          observations,
          firstResult.warnings ?? [],
        );
      } else if (observations.length === 0) {
        printWarnings(firstResult.warnings);
        console.log('No observations produced.');
      } else {
        printWarnings(firstResult.warnings);
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
      .choices(['toon', 'json', 'text'])

      .default(undefined, 'auto (toon for agents, text for humans)'),
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
        format: string | undefined;
      },
    ) => {
      const format = resolveFormat(options.format);
      const json = format === 'json';
      const toon = format === 'toon';
      const monitorsDir = path.resolve(options.dir);
      const workspacePath = path.resolve(options.workspace ?? process.cwd());
      const historyLimit = Number.parseInt(options.historyLimit, 10);
      const eventLimit = Number.parseInt(options.eventLimit, 10);
      const socketPath = resolveSocketPath(options.socket, {
        explicit: options.socket !== undefined,
      });
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
          socketPath,
        );

        if (json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        if (toon) {
          console.log(renderToon(report));
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
        // The daemon is unreachable. A read-only diagnosis tool must not require
        // a live daemon: read the persisted SQLite store in-process and run the
        // SAME explain the daemon would (issue #150, PM decision (a)). This gives
        // the real per-stage diagnosis from the last tick — NOT a false
        // "✗ Scheduling: failure" for a monitor that actually fired.
        const report = await explainMonitorInProcess({
          monitorId,
          monitorsDir,
          workspacePath,
          ...(Number.isFinite(historyLimit) && historyLimit > 0
            ? { historyLimit }
            : {}),
          ...(Number.isFinite(eventLimit) && eventLimit > 0
            ? { eventLimit }
            : {}),
        });

        // Decide how to surface the in-process report based on what it contains.
        //
        // Three cases:
        //
        // (A) Definition stage is not 'ok' (parse error, monitor not found,
        //     duplicate ID, unknown source, …). The report carries the exact
        //     failure the author needs. Show it WITHOUT the no-daemon banner —
        //     there is no persisted state involved; the banner would be
        //     misleading. Exit 0 (mirrors the live-daemon path).
        //
        // (B) Definition stage is 'ok' AND there IS persisted state (observation
        //     history or materialized events). The report is a real diagnosis from
        //     the last tick. Show it WITH the no-daemon banner so the author knows
        //     it came from the store, not a live daemon. Exit 0.
        //
        // (C) Definition stage is 'ok' AND nothing has been persisted (no
        //     observations, no events). The daemon is down and nothing has ever
        //     ticked. Show the actionable remediation line (issue #150, PM
        //     decision (b)(i)) — not a raw ENOENT. Exit 1.
        //     NOTE: a definition-failure report must never be replaced by the
        //     remediation message; definition failures reach case (A).
        const definitionStage = report.stages.find(
          (stage) => stage.id === 'definition',
        );
        const definitionOk = definitionStage?.status === 'ok';
        const hasPersistedState =
          report.observations.length > 0 || report.events.length > 0;

        if (!definitionOk) {
          // Case (A): definition failure — show report, no banner.
          if (json) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          if (toon) {
            console.log(renderToon(report));
            return;
          }
          printExplainText(report);
          return;
        }

        if (!hasPersistedState) {
          // Case (C): definition ok, nothing persisted — remediation only.
          reportError(NO_DAEMON_REMEDIATION, json);
          return;
        }

        // Case (B): definition ok, persisted state exists — show report + banner.
        if (json) {
          // Preserve the full report and annotate that it came from the
          // persisted-state fallback (the daemon was not reached).
          console.log(
            JSON.stringify({ notice: NO_DAEMON_BANNER, ...report }, null, 2),
          );
          return;
        }
        if (toon) {
          // Annotate the TOON report with the no-daemon notice in the same way
          // the JSON path does — spread notice into the encoded object.
          console.log(renderToon({ notice: NO_DAEMON_BANNER, ...report }));
          return;
        }
        console.log(NO_DAEMON_BANNER);
        printExplainText(report);
      }
    },
  );

monitorTestCommand
  .command('history')
  .description(
    'Show recent observation outcomes per tick (triggered / suppressed / no-change / no-files-matched / errored / rebaselined)',
  )
  .argument('[monitorId]', 'Filter to a single monitor id')
  .option('--socket <path>', 'Unix domain socket path for the daemon')
  .option('--limit <n>', 'Maximum rows to return', '50')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['toon', 'json', 'text'])

      .default(undefined, 'auto (toon for agents, text for humans)'),
  )
  .action(
    async (
      monitorId: string | undefined,
      options: { socket?: string; limit: string; format: string | undefined },
    ) => {
      const format = resolveFormat(options.format);
      const json = format === 'json';
      const toon = format === 'toon';
      const limit = Number.parseInt(options.limit, 10);
      const query = {
        ...(monitorId ? { monitorId } : {}),
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      };
      const socketPath = resolveSocketPath(options.socket, {
        explicit: options.socket !== undefined,
      });
      try {
        const records = await listObservationHistoryClient(query, socketPath);

        if (json) {
          console.log(JSON.stringify(records, null, 2));
          return;
        }
        if (toon) {
          console.log(renderToon(records));
          return;
        }
        // text format
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
        // Only fall back to the in-process DB read when the daemon was genuinely
        // unreachable. A daemon-side application error must surface verbatim
        // (mirrors `monitor explain`; the #94/#98 distinction must hold).
        if (!(err instanceof DaemonConnectionError)) {
          reportError(`History failed: ${message}`, json);
          return;
        }
        // The daemon is unreachable. Read observation history directly from the
        // persisted SQLite store in-process (issue #150, PM decision (a)) —
        // history is read-only durable state and shouldn't need a live daemon.
        const records = listObservationHistoryInProcess(query);
        if (records.length === 0) {
          // Daemon down AND nothing persisted → actionable remediation, not a
          // raw ENOENT (issue #150, PM decision (b)(i)).
          reportError(NO_DAEMON_REMEDIATION, json);
          return;
        }
        if (json) {
          console.log(JSON.stringify(records, null, 2));
          return;
        }
        if (toon) {
          // Print the no-daemon banner first (as in text mode) so the author
          // knows the data came from persisted store, then the TOON payload.
          console.log(NO_DAEMON_BANNER);
          console.log(renderToon(records));
          return;
        }
        console.log(NO_DAEMON_BANNER);
        for (const record of records) {
          console.log(
            `${String(record.createdAt)}  ${record.result.padEnd(10)}  ${record.monitorId}  (${record.sourceName})`,
          );
        }
      }
    },
  );
