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
  # remote branch tip directly; remote-ref commands like this "git ls-remote"
  # or "git rev-parse origin/main" only reflect your last fetch, so they can
  # lag until you fetch again. That caveat is specific to remote refs — a
  # local-state command such as "git status --porcelain" has no such lag.
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
const VALID_URGENCIES = ['low', 'normal', 'high'];

/**
 * Types whose template has a seedable path-pattern list: `globs:` for
 * `file-fingerprint`, `paths:` for `incoming-changes` (spec 001 §2 field
 * names differ per source even though `--glob` addresses both). Types not
 * in this map have no such block, so `--glob` is rejected for them.
 */
const GLOB_FIELD_BY_TYPE: Partial<Record<string, 'globs' | 'paths'>> = {
  'file-fingerprint': 'globs',
  'incoming-changes': 'paths',
};

/** Thrown when a seed flag (`--glob`/`--name`/`--urgency`) can't be applied
 * to the chosen `--type`. Caught by the action handler and reported as a
 * normal CLI error (message + exit code 1), not a stack trace. */
class InitSeedError extends Error {}

/** Seed values from `--glob`/`--name`/`--urgency`, threaded into the
 * generated frontmatter value-preserving (issue #330). Only the named `init <name>`
 * scaffold path consumes these; the bare bootstrap form ignores them
 * (non-goal). */
interface SeedOptions {
  name?: string;
  urgency?: string;
  globs?: string[];
}

/**
 * Render `value` as a single-quoted YAML flow scalar, matching the quoting
 * style the templates already use for string fields (`'**\/*.ts'`,
 * `'https://example.com/page'`). Single-quoted YAML scalars have exactly one
 * escape rule — a literal `'` doubles to `''` — so this is safe for
 * arbitrary user-supplied text (colons, `#`, backslashes, etc. all pass
 * through unescaped and unmisinterpreted).
 */
function yamlSingleQuoted(value: string): string {
  // A single-quoted YAML scalar cannot safely span lines at an arbitrary
  // indent; reject control characters outright rather than emit a scaffold
  // that fails its own `validate` step.
  if (/[\r\n]/.test(value)) {
    throw new InitSeedError(
      'Seed values must be single-line (newlines are not allowed).',
    );
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** Replace the template's `name:` frontmatter line with the seeded value. */
function seedName(template: string, name: string): string {
  return template.replace(/^name: .*$/m, `name: ${yamlSingleQuoted(name)}`);
}

/**
 * Derive a readable frontmatter `name:` from the positional `<name>`
 * argument when `--name` is not given (issue #375): without this, the
 * scaffold's literal template placeholder (e.g. `My monitor`) survives
 * untouched, so a rushed author can commit a monitor that is never renamed.
 * Splits on `-`/`_` and capitalizes the first word, e.g. `watch-docs` ->
 * `Watch docs`. Falls back to the positional verbatim if it has no such
 * separators (e.g. `watchdocs` -> `Watchdocs`).
 */
function deriveNameFromPositional(positional: string): string {
  const words = positional.split(/[-_]+/).filter((word) => word.length > 0);
  if (words.length === 0) return positional;
  const [first, ...rest] = words;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `words.length > 0` guarantees `first` is defined.
  const capitalized = `${first!.charAt(0).toUpperCase()}${first!.slice(1)}`;
  return [capitalized, ...rest].join(' ');
}

/** Replace the template's `urgency:` frontmatter line with the seeded value.
 * `urgency` is Commander-`.choices()`-constrained to {@link VALID_URGENCIES},
 * so it's always a bare, unquoted YAML scalar. */
function seedUrgency(template: string, urgency: string): string {
  return template.replace(/^urgency: .*$/m, `urgency: ${urgency}`);
}

/**
 * Replace the template's seedable path-pattern list (`globs:` or `paths:`,
 * per {@link GLOB_FIELD_BY_TYPE}) with the seeded patterns. Throws
 * {@link InitSeedError} for a `type` with no such block (e.g. `api-poll`,
 * `command-poll`, `schedule`) so the CLI reports a clear error instead of
 * silently dropping the flag.
 */
function seedGlobs(template: string, type: string, globs: string[]): string {
  const field = GLOB_FIELD_BY_TYPE[type];
  if (field === undefined) {
    throw new InitSeedError(
      `--glob is not supported for --type ${type} (only file-fingerprint and incoming-changes have a path-pattern list)`,
    );
  }
  // Derive the list-item indent from the template's own first item so
  // seeding follows the template if its indentation ever changes.
  const blockPattern = new RegExp(
    `^( *)${field}:\\n(( +)- .*\\n)(?:\\3- .*\\n)*`,
    'm',
  );
  return template.replace(
    blockPattern,
    (_match, indent: string, _first: string, itemIndent: string) => {
      const listBlock = globs
        .map((pattern) => `${itemIndent}- ${yamlSingleQuoted(pattern)}`)
        .join('\n');
      return `${indent}${field}:\n${listBlock}\n`;
    },
  );
}

/**
 * Apply `--glob`/`--name`/`--urgency` seed overrides to a template, in
 * frontmatter-field order. A `SeedOptions` with all fields `undefined`
 * returns `template` unchanged. As of issue #375, the named scaffold path's
 * caller always passes a `name` seed (the `--name` value, or one derived
 * from the positional `<name>` when `--name` is omitted), so a zero-flag
 * `init <name>` no longer returns the raw template byte-for-byte — only its
 * `name:` line differs from the template default. The bare bootstrap path
 * never calls this with a `name` seed, so its scaffolded templates are
 * unaffected (non-goal, issue #330).
 */
function applySeeds(
  template: string,
  type: string,
  seeds: SeedOptions,
): string {
  let result = template;
  if (seeds.name !== undefined) result = seedName(result, seeds.name);
  if (seeds.urgency !== undefined) result = seedUrgency(result, seeds.urgency);
  if (seeds.globs !== undefined && seeds.globs.length > 0) {
    result = seedGlobs(result, type, seeds.globs);
  }
  return result;
}

/** Commander `.option()` collector for repeatable `--glob <pattern>`. */
function collectGlob(value: string, previous: string[]): string[] {
  return [...previous, value];
}

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

/**
 * `.agentmonitors/` is the project-root runtime directory the core writes
 * per-session hook state into (`<workspace>/.agentmonitors/sessions/<id>/hook-state.json`,
 * see `libs/core/src/adapter/claude.ts#defaultHookStatePath` and
 * docs/specs/002-runtime-delivery.md §11.3). It is created the moment a
 * session opens — before any user opts into it — so it must be ignored
 * alongside {@link GITIGNORE_LINE} rather than left for the user to discover
 * in `git status` (issue #336). Every file under it is a materialized,
 * regenerable projection of the runtime's SQLite store, never the source of
 * truth, so it is safe to delete.
 */
const RUNTIME_DIR_GITIGNORE_LINE = '/.agentmonitors/';

/** All lines `agentmonitors init` ensures are present in `.gitignore`. */
const GITIGNORE_LINES = [GITIGNORE_LINE, RUNTIME_DIR_GITIGNORE_LINE] as const;

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
 *
 * `seeds` (default `{}`, i.e. no-op) lets the named scaffold path override
 * specific frontmatter fields (value-preserving) via `--glob`/`--name`/`--urgency`
 * (issue #330); the bootstrap path never passes seeds, so its output is
 * unaffected. Seeding is applied — and can throw {@link InitSeedError} — before
 * any filesystem write, so a rejected seed (e.g. `--glob` on a type with no
 * path-pattern list) never leaves a partial directory behind.
 */
function scaffoldMonitor(
  dir: string,
  name: string,
  type: string,
  seeds: SeedOptions = {},
): ScaffoldResult {
  // Commander's .choices() guarantees a valid key on the named path; the
  // bootstrap validates the interactive/`--yes` type before calling here.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const template = TEMPLATES[type]!;
  const monitorDir = path.join(dir, name);
  if (existsSync(path.join(monitorDir, 'MONITOR.md'))) {
    return { status: 'exists', monitorDir };
  }
  const content = applySeeds(template, type, seeds);
  mkdirSync(monitorDir, { recursive: true });
  writeFileSync(path.join(monitorDir, 'MONITOR.md'), content, 'utf-8');
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
 * Bootstrap step 2: ensure `.gitignore` ignores the local coordination file
 * and the `.agentmonitors/` runtime directory ({@link GITIGNORE_LINES}).
 * Appends whichever lines are missing, creates the file if absent, and is a
 * no-op if every line is already present. Each line is checked independently,
 * so a `.gitignore` that already has one line but not the other only gets the
 * missing one appended (same append-if-missing semantics as a single line).
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
    writeFileSync(target, `${GITIGNORE_LINES.join('\n')}\n`, 'utf-8');
    return 'created';
  }
  const existingLines = new Set(content.split('\n').map((line) => line.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !existingLines.has(line));
  if (missing.length === 0) return 'present';
  const needsNewline = content.length > 0 && !content.endsWith('\n');
  writeFileSync(
    target,
    `${content}${needsNewline ? '\n' : ''}${missing.join('\n')}\n`,
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
    console.log(`  .gitignore already ignores ${GITIGNORE_LINES.join(', ')}`);
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
      ? `  .gitignore already ignores  ${GITIGNORE_LINES.join(', ')}`
      : `  Updated .gitignore          ${GITIGNORE_LINES.join(', ')}`,
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
    "  • If you're using the AgentMon Claude Code plugin, monitoring starts automatically",
  );
  console.log(
    '    the next time you open a Claude Code session (SessionStart lazy-boots the daemon).',
  );
  console.log(
    `  • Otherwise, start the daemon yourself:  agentmonitors daemon run ${options.dir}`,
  );
  console.log(
    `  • Or run a one-shot tick now:  agentmonitors daemon once ${options.dir}`,
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
  .option(
    '--glob <pattern>',
    'Seed watch.globs (file-fingerprint) or watch.paths (incoming-changes); repeatable. Scaffold form only.',
    collectGlob,
    [],
  )
  .option(
    '--name <name>',
    'Seed the frontmatter name: field (distinct from the positional <name>, which sets the directory). Defaults to a readable form of the positional <name>. Scaffold form only.',
  )
  .addOption(
    new Option(
      '--urgency <urgency>',
      'Seed the frontmatter urgency: field. Scaffold form only.',
    ).choices(VALID_URGENCIES),
  )
  .action(
    async (
      name: string | undefined,
      options: {
        dir: string;
        type: string;
        enableOnly?: boolean;
        yes?: boolean;
        glob: string[];
        name?: string;
        urgency?: string;
      },
    ) => {
      // Named form: `init <name> --type ...` — unchanged scaffold behavior
      // when no seed flags are passed (AC3, issue #330), except that the
      // frontmatter `name:` now always derives from the positional `<name>`
      // rather than surviving as the template's literal placeholder
      // (issue #375). `--name` still overrides.
      if (name !== undefined) {
        // `urgency`/`globs` are built conditionally (not `field: value ??
        // undefined`) because `exactOptionalPropertyTypes` treats an
        // explicit `undefined` value differently from an absent key; `name`
        // always has a value now (seeded or derived) so it's set directly.
        const seeds: SeedOptions = {
          name: options.name ?? deriveNameFromPositional(name),
          ...(options.urgency !== undefined
            ? { urgency: options.urgency }
            : {}),
          ...(options.glob.length > 0 ? { globs: options.glob } : {}),
        };
        let result: ScaffoldResult;
        try {
          result = scaffoldMonitor(options.dir, name, options.type, seeds);
        } catch (err) {
          if (err instanceof InitSeedError) {
            console.error(err.message);
            process.exitCode = 1;
            return;
          }
          throw err;
        }
        const { status, monitorDir } = result;
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

      // Bare form: `init` — one-shot project bootstrap. Seed flags
      // (--glob/--name/--urgency) are intentionally not consumed here
      // (non-goal, issue #330): the bootstrap form's behavior is unchanged.
      await runBootstrap(options);
    },
  );
