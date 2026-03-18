import { existsSync, readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { Command, Option } from 'commander';
import {
  parseMonitor,
  SourceRegistry,
  type ObservationSource,
  type Observation,
} from '@agentmonitors/core';
import { registerCoreSources } from '../sources.js';
import { reportError } from '../output.js';

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

/** Handle the baseline-then-detect flow for stateful sources. */
async function handleStatefulSource(
  source: ObservationSource,
  scope: Record<string, unknown>,
  monitorName: string,
  json: boolean,
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
  const secondObservations = await source.observe(scope);

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

    const content = readFileSync(filePath, 'utf-8');
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
      const observations = await source.observe(
        result.monitor.frontmatter.scope,
      );

      if (observations.length === 0 && source.stateful) {
        await handleStatefulSource(
          source,
          result.monitor.frontmatter.scope,
          monitorName,
          json,
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
