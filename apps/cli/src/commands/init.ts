import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';

const yaml = String.raw;

const TEMPLATES: Record<string, string> = {
  'file-fingerprint': yaml`
---
name: My monitor
source: file-fingerprint
urgency: normal
event-kind: mutation
scope:
  globs:
    - '**/*.ts'
---

When changes are detected, review and take appropriate action.
`.trimStart(),

  'api-poll': yaml`
---
name: My API monitor
source: api-poll
urgency: normal
event-kind: notification
scope:
  url: 'https://api.example.com/endpoint'
  method: GET
  interval: 5m
  change-detection:
    strategy: json-diff
---

When the API response changes, review the differences and take appropriate action.
`.trimStart(),

  schedule: yaml`
---
name: My scheduled monitor
source: schedule
urgency: normal
event-kind: notification
scope:
  cron: '0 9 * * 1-5'
  timezone: UTC
---

This monitor fires on a schedule. Review and take appropriate action.
`.trimStart(),
};

const VALID_SOURCES = Object.keys(TEMPLATES);

export const initCommand = new Command('init')
  .description('Scaffold a new monitor directory with a template MONITOR.md')
  .argument('<name>', 'Monitor name (kebab-case, becomes the directory name)')
  .option('--dir <dir>', 'Base directory for monitors', '.claude/monitors')
  .addOption(
    new Option('--source <source>', 'Observation source')
      .choices(VALID_SOURCES)
      .default('file-fingerprint'),
  )
  .action((name: string, options: { dir: string; source: string }) => {
    // Commander's .choices() guarantees options.source is a valid key
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const template = TEMPLATES[options.source]!;

    const monitorDir = path.join(options.dir, name);

    if (existsSync(path.join(monitorDir, 'MONITOR.md'))) {
      console.error(`Monitor already exists: ${monitorDir}/MONITOR.md`);
      process.exitCode = 1;
      return;
    }

    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(path.join(monitorDir, 'MONITOR.md'), template, 'utf-8');
    console.log(`Created monitor: ${monitorDir}/MONITOR.md`);
    console.log(`\nEdit the file to configure your monitor, then run:`);
    console.log(`  agentmonitors validate ${options.dir}`);
  });
