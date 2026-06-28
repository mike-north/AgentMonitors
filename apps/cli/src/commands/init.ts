import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';

const yaml = String.raw;

const TEMPLATES: Record<string, string> = {
  'file-fingerprint': yaml`
---
name: My monitor
watch:
  type: file-fingerprint
  globs:
    - '**/*.ts'
urgency: normal
---

When changes are detected, review and take appropriate action.
`.trimStart(),

  'api-poll': yaml`
---
name: My API monitor
watch:
  type: api-poll
  url: 'https://api.example.com/endpoint'
  method: GET
  interval: 5m
  # Use text-diff for HTML/plain pages. For JSON APIs, switch to json-diff.
  change-detection:
    strategy: text-diff
urgency: normal
---

When the API response changes, review the differences and take appropriate action.
`.trimStart(),

  'command-poll': yaml`
---
name: My command monitor
watch:
  type: command-poll
  # command is an argv array, run directly (no shell). For a pipeline or other
  # shell operators, wrap it: command: ['sh', '-c', 'git status -sb | grep ahead']
  command:
    - git
    - status
    - --porcelain
  interval: 5m
  change-detection:
    strategy: text-diff
urgency: normal
---

When the command output changes, review the differences and take appropriate action.
`.trimStart(),

  schedule: yaml`
---
name: My scheduled monitor
watch:
  type: schedule
  cron: '0 9 * * 1-5'
  timezone: UTC
urgency: normal
---

This monitor fires on a schedule. Review and take appropriate action.
`.trimStart(),

  'incoming-changes': yaml`
---
name: Spec changes from upstream
watch:
  type: incoming-changes
  paths:
    - 'docs/specs/**'
  branch: main
urgency: normal
---

The spec documents changed in the latest pull. Summarize what changed and
whether it affects what I'm currently working on.
`.trimStart(),
};

const VALID_TYPES = Object.keys(TEMPLATES);

export const initCommand = new Command('init')
  .description('Scaffold a new monitor directory with a template MONITOR.md')
  .argument('<name>', 'Monitor name (kebab-case, becomes the directory name)')
  .option('--dir <dir>', 'Base directory for monitors', '.claude/monitors')
  .addOption(
    new Option('--type <type>', 'Observation source type')
      .choices(VALID_TYPES)
      .default('file-fingerprint'),
  )
  .action((name: string, options: { dir: string; type: string }) => {
    // Commander's .choices() guarantees options.type is a valid key
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const template = TEMPLATES[options.type]!;

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
