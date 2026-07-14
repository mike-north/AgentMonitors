import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { Command, Option } from 'commander';
import { readLocalState } from '../local-state.js';
import { validateCommand } from './validate.js';

const yaml = String.raw;
const md = String.raw;

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
name: My web page monitor
watch:
  type: api-poll
  # The common "watch a page" case needs NO change-detection block: the strategy
  # is inferred from the response Content-Type — JSON bodies (application/json,
  # *+json) use json-diff, everything else (HTML/plain-text/unknown) uses
  # text-diff. Set change-detection.strategy explicitly only to override the
  # inferred default; an explicit value always wins:
  #   text-diff   — compare the raw body (good for HTML / plain-text pages)
  #   json-diff   — compare JSON semantically, ignoring key order/whitespace
  #   status-code — only fire when the HTTP status changes (e.g. 200 -> 503)
  url: 'https://example.com/page'
  method: GET
  interval: 5m
urgency: normal
---

When the page changes, review the differences and take appropriate action.
`.trimStart(),

  'command-poll': yaml`
---
name: Upstream branch monitor
watch:
  type: command-poll
  # command is an argv array, run directly (no shell). This example watches the
  # remote branch tip directly; local commands such as "git status" or
  # "git rev-parse origin/main" can stay stale until you fetch.
  command:
    - git
    - ls-remote
    - origin
    - refs/heads/main
  interval: 5m
  change-detection:
    strategy: text-diff
urgency: normal
---

When the upstream branch changes, review the new commits and decide whether they
affect this workspace.
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
const DEFAULT_TYPE = 'file-fingerprint';
const DEFAULT_MONITOR_NAME = 'my-monitor';

/**
 * The project-enable file, written verbatim from the setup-monitors skill's
 * "Enable The Project" section
 * (`agent-plugins/agentmonitors/skills/setup-monitors/SKILL.md`). It is the exact
 * minimal shape the skill documents: only `enabled: true` is required for the
 * session-start hook to register the daemon. `session start` later augments this
 * file (socket/db/reap fields) via `writeLocalState` when a session opens, so we
 * intentionally write the minimal form here and never clobber an already-enabled
 * file (see {@link ensureEnabled}).
 */
const ENABLE_FILE_CONTENTS = md`
---
enabled: true
---

> Local AgentMon coordination state. Gitignored; safe to delete (it is regenerated).
`.trimStart();

/** The single line the setup-monitors skill requires in `.gitignore`. */
const GITIGNORE_LINE = '.claude/*.local.*';

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

interface ScaffoldResult {
  status: 'created' | 'exists';
  /** Directory of the scaffolded monitor (its `MONITOR.md` lives inside). */
  monitorDir: string;
}

/**
 * Write a template `MONITOR.md` for `type` into `<dir>/<name>/`. Shared by the
 * named `init <name>` scaffold path and the bare-init bootstrap so both produce
 * byte-identical monitor files. Never overwrites an existing monitor: returns
 * `status: 'exists'` so each caller can decide how to react (the named path
 * errors; the bootstrap treats it as an idempotent no-op).
 */
function scaffoldMonitor(
  dir: string,
  name: string,
  type: string,
): ScaffoldResult {
  // Commander's .choices() guarantees a valid key on the named path; the
  // bootstrap validates the interactive/`--yes` type before calling here.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const template = TEMPLATES[type]!;
  const monitorDir = path.join(dir, name);
  if (existsSync(path.join(monitorDir, 'MONITOR.md'))) {
    return { status: 'exists', monitorDir };
  }
  mkdirSync(monitorDir, { recursive: true });
  writeFileSync(path.join(monitorDir, 'MONITOR.md'), template, 'utf-8');
  return { status: 'created', monitorDir };
}

/**
 * Bootstrap step 1: ensure the project is enabled. Reuses `readLocalState` to
 * detect an already-enabled project so a re-run never rewrites the file (which
 * would clobber socket/db fields a prior `session start` persisted).
 *
 * `readLocalState`'s minimal frontmatter parser only recognizes a bare `---`
 * as the block delimiter (see `local-state.ts`'s `parseFrontmatter`), so a
 * BOM-prefixed file (a literal U+FEFF before `---`) — which some editors/tools
 * write — fails that check and reports `enabled: false` even though the file
 * already declares `enabled: true`. Before writing, fall back to a raw-text
 * check (BOM stripped) so we never clobber an already-enabled file's
 * socket/db fields.
 */
function ensureEnabled(cwd: string): 'created' | 'already-enabled' {
  if (readLocalState(cwd).enabled) return 'already-enabled';
  const target = path.join(cwd, '.claude', 'agentmonitors.local.md');
  let existingRaw: string | undefined;
  try {
    existingRaw = readFileSync(target, 'utf-8');
  } catch {
    existingRaw = undefined;
  }
  if (existingRaw !== undefined) {
    const stripped = existingRaw.replace(/^\uFEFF/, '');
    if (stripped.includes('enabled: true')) {
      return 'already-enabled';
    }
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, ENABLE_FILE_CONTENTS, 'utf-8');
  return 'created';
}

/**
 * Bootstrap step 2: ensure `.gitignore` ignores the local coordination file.
 * Appends the line if the file exists but lacks it, creates the file if absent,
 * and is a no-op if the line is already present.
 *
 * Only a missing file (`ENOENT`) is treated as "absent, create it". Any other
 * read error (e.g. `EACCES` on an unreadable file, `EISDIR` when `.gitignore`
 * is actually a directory) is rethrown so the command fails loudly instead of
 * silently overwriting something that isn't a plain, absent file.
 */
function ensureGitignore(cwd: string): 'created' | 'appended' | 'present' {
  const target = path.join(cwd, '.gitignore');
  let content: string;
  try {
    content = readFileSync(target, 'utf-8');
  } catch (err) {
    if (!isErrnoException(err) || err.code !== 'ENOENT') throw err;
    writeFileSync(target, `${GITIGNORE_LINE}\n`, 'utf-8');
    return 'created';
  }
  const present = content
    .split('\n')
    .some((line) => line.trim() === GITIGNORE_LINE);
  if (present) return 'present';
  const needsNewline = content.length > 0 && !content.endsWith('\n');
  writeFileSync(
    target,
    `${content}${needsNewline ? '\n' : ''}${GITIGNORE_LINE}\n`,
    'utf-8',
  );
  return 'appended';
}

/**
 * Interactively ask whether to scaffold a starter monitor and, if so, for its
 * source type and name. Returns `null` when the author declines. Only ever
 * called on a TTY (see {@link runBootstrap}); non-interactive callers use flags.
 */
async function promptForMonitor(): Promise<{
  name: string;
  type: string;
} | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const add = (await rl.question('Scaffold a starter monitor now? [Y/n] '))
      .trim()
      .toLowerCase();
    if (add === 'n' || add === 'no') return null;

    let type = DEFAULT_TYPE;
    for (;;) {
      const answer = (
        await rl.question(
          `Source type (${VALID_TYPES.join(', ')}) [${DEFAULT_TYPE}]: `,
        )
      ).trim();
      if (answer === '') break;
      if (VALID_TYPES.includes(answer)) {
        type = answer;
        break;
      }
      console.log(
        `Unknown source type "${answer}". Try one of the listed types.`,
      );
    }

    const nameAnswer = (
      await rl.question(`Monitor name [${DEFAULT_MONITOR_NAME}]: `)
    ).trim();
    const name = nameAnswer === '' ? DEFAULT_MONITOR_NAME : nameAnswer;
    return { name, type };
  } finally {
    rl.close();
  }
}

type MonitorOutcome =
  | { kind: 'created' | 'exists'; monitorDir: string; name: string }
  | { kind: 'enable-only' }
  | { kind: 'declined' }
  | { kind: 'skipped-noninteractive' };

interface BootstrapOptions {
  dir: string;
  type: string;
  enableOnly?: boolean;
  yes?: boolean;
}

/**
 * Bare `agentmonitors init`: one-shot project bootstrap. Enables the project,
 * fixes `.gitignore`, optionally scaffolds a first monitor, validates the
 * result, and prints a "what happens next + how to verify" summary. Idempotent:
 * a re-run on an already-set-up project changes nothing and says so.
 */
async function runBootstrap(options: BootstrapOptions): Promise<void> {
  const cwd = process.cwd();

  const enableStatus = ensureEnabled(cwd);
  const gitignoreStatus = ensureGitignore(cwd);

  let monitor: MonitorOutcome = { kind: 'enable-only' };
  if (!options.enableOnly) {
    // `isTTY` is typed `boolean` but is `undefined` for a non-TTY stdin at
    // runtime; either way, a falsy value means we must not prompt.
    const canPrompt = process.stdin.isTTY && !options.yes;
    let choice: { name: string; type: string } | null = null;
    if (canPrompt) {
      choice = await promptForMonitor();
      monitor = choice ? monitor : { kind: 'declined' };
    } else if (options.yes) {
      choice = { name: DEFAULT_MONITOR_NAME, type: options.type };
    } else {
      // Not a TTY and no --yes: we cannot prompt (agents/scripts pass flags).
      monitor = { kind: 'skipped-noninteractive' };
    }
    if (choice) {
      const result = scaffoldMonitor(options.dir, choice.name, choice.type);
      monitor = {
        kind: result.status,
        monitorDir: result.monitorDir,
        name: choice.name,
      };
    }
  }

  const nothingChanged =
    enableStatus === 'already-enabled' &&
    gitignoreStatus === 'present' &&
    monitor.kind !== 'created';

  if (nothingChanged) {
    console.log(
      'AgentMon is already set up in this project — nothing to change.',
    );
    console.log(`  Monitoring enabled:  .claude/agentmonitors.local.md`);
    console.log(`  .gitignore already ignores ${GITIGNORE_LINE}`);
    console.log(
      `\nAdd another monitor with:  agentmonitors init <name> --type <type>`,
    );
    console.log('Check overall health any time:  agentmonitors doctor');
    return;
  }

  console.log('AgentMon project setup');
  console.log(
    enableStatus === 'created'
      ? '  Enabled monitoring          .claude/agentmonitors.local.md'
      : '  Monitoring already enabled  .claude/agentmonitors.local.md',
  );
  console.log(
    gitignoreStatus === 'present'
      ? `  .gitignore already ignores  ${GITIGNORE_LINE}`
      : `  Updated .gitignore          ${GITIGNORE_LINE}`,
  );

  if (monitor.kind === 'created') {
    console.log(
      `  Scaffolded monitor          ${monitor.monitorDir}/MONITOR.md`,
    );
  } else if (monitor.kind === 'exists') {
    console.log(
      `  Monitor already exists      ${monitor.monitorDir}/MONITOR.md (left unchanged)`,
    );
  }

  // Step: validate the just-scaffolded monitor by running the real `validate`
  // command in-process (no behavior of its own reinvented here — AP6).
  if (monitor.kind === 'created') {
    console.log(`\nValidating ${options.dir}:`);
    await validateCommand.parseAsync([options.dir], { from: 'user' });
  }

  console.log('\nWhat happens next');
  console.log(
    '  • Monitoring starts automatically when you open a Claude Code session',
  );
  console.log(
    '    (the SessionStart hook lazy-boots the daemon — no manual start needed).',
  );
  console.log(
    `  • Run a one-shot tick now:  agentmonitors daemon once ${options.dir}`,
  );
  console.log('  • Check overall health any time:  agentmonitors doctor');

  if (monitor.kind === 'created') {
    console.log('\nVerify the monitor fires');
    console.log(
      `  • Dry-run its source:  agentmonitors monitor test ${monitor.monitorDir}/MONITOR.md`,
    );
    console.log(
      '  • Full fire-and-deliver recipe: see the setup-monitors skill, "Verify It Fires".',
    );
    console.log(
      `\nEdit ${monitor.monitorDir}/MONITOR.md to configure what it watches.`,
    );
  } else {
    // No monitor scaffolded (enable-only, declined, or non-interactive skip).
    console.log('\nAdd a monitor with:');
    console.log(
      `  agentmonitors init <name> --type <${VALID_TYPES.join('|')}>`,
    );
    if (monitor.kind === 'skipped-noninteractive') {
      console.log(
        '  (or re-run `agentmonitors init --yes` to scaffold a starter monitor)',
      );
    }
    console.log(`Then verify it:  agentmonitors validate ${options.dir}`);
  }
}

export const initCommand = new Command('init')
  .description(
    'Bootstrap AgentMon in this project (no name), or scaffold a single monitor (with a name)',
  )
  .argument(
    '[name]',
    'Monitor name (kebab-case, becomes the directory name). Omit to bootstrap the project.',
  )
  .option('--dir <dir>', 'Base directory for monitors', '.claude/monitors')
  .addOption(
    new Option('--type <type>', 'Observation source type')
      .choices(VALID_TYPES)
      .default(DEFAULT_TYPE),
  )
  .option(
    '--enable-only',
    'Bootstrap only: enable the project and update .gitignore (no monitor, no prompts)',
  )
  .option(
    '--yes',
    'Bootstrap non-interactively: accept defaults and scaffold a starter monitor',
  )
  .action(
    async (
      name: string | undefined,
      options: {
        dir: string;
        type: string;
        enableOnly?: boolean;
        yes?: boolean;
      },
    ) => {
      // Named form: `init <name> --type ...` — unchanged scaffold behavior.
      if (name !== undefined) {
        const { status, monitorDir } = scaffoldMonitor(
          options.dir,
          name,
          options.type,
        );
        if (status === 'exists') {
          console.error(`Monitor already exists: ${monitorDir}/MONITOR.md`);
          process.exitCode = 1;
          return;
        }
        console.log(`Created monitor: ${monitorDir}/MONITOR.md`);
        console.log(`\nEdit the file to configure your monitor, then run:`);
        console.log(`  agentmonitors validate ${options.dir}`);
        console.log(`  agentmonitors doctor`);
        return;
      }

      // Bare form: `init` — one-shot project bootstrap.
      await runBootstrap(options);
    },
  );
