import { existsSync, readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { Command, Option } from 'commander';
import {
  parseMonitor,
  SourceRegistry,
  type ObservationContext,
  type ObservationSource,
  type Observation,
} from '@mike-north/core';
import { registerCoreSources } from '../sources.js';
import { reportError } from '../output.js';
import { listObservationHistoryClient } from '../runtime-client.js';

export const monitorTestCommand = new Command('monitor').description(
  'Monitor utilities',
);

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

    const source = registry.get(result.monitor.frontmatter.source);
    if (!source) {
      reportError(
        `Unknown source: "${result.monitor.frontmatter.source}". Available: ${registry.names().join(', ')}`,
        json,
      );
      return;
    }

    const monitorName = result.monitor.frontmatter.name;

    if (!json) {
      console.log(
        `Testing monitor "${monitorName}" (source: ${source.name})...`,
      );
    }

    try {
      let context: ObservationContext = { now: new Date() };
      const firstResult = await source.observe(
        result.monitor.frontmatter.scope,
        context,
      );
      const observations = firstResult.observations;
      context = {
        now: new Date(),
        previousState: firstResult.nextState,
      };

      if (observations.length === 0 && source.stateful) {
        await handleStatefulSource(
          source,
          result.monitor.frontmatter.scope,
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
  .command('history')
  .description(
    'Show recent observation outcomes per tick (triggered / suppressed / no-change)',
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
