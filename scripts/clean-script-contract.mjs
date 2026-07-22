// Guards the workspace's `clean` script contract (issue #443): every
// package with its own api-extractor config pair must remove BOTH `dist`
// and the api-extractor scratch dir `temp` (not just `dist`), and the root
// `clean` script must fan that out across every project via
// `nx run-many --target=clean` (excluding the workspace root project
// itself, which has no `clean` target) and then reset the Nx cache/daemon
// via `nx reset` — with `NX_TUI=false` scoped to EACH invocation
// individually, not shared across the chain.
//
// Before this guard existed, nothing in CI ever invoked `pnpm clean` (it
// has no build/test/type-check side effect, so it can't be caught by any
// other check), so the clean contract had zero regression protection: a
// future package could add its own `dist`-only clean script, or the root
// script could silently regress to `rm -rf dist` shapes or lose its
// `nx reset` step, and CI would stay green.
//
// `findApiExtractorPackageDirs` discovers qualifying packages by walking
// the real filesystem for the `api-extractor.build.json` +
// `api-extractor.report.json` pair — deliberately NOT a hardcoded list of
// package names — so a newly added package automatically falls under this
// guard the moment it gains an api-extractor config, with no separate
// "remember to add it here" step.

import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repo root, derived the same way as every other path this module exports. */
export const REPO_ROOT = join(scriptDir, '..');

/** Absolute path to the real, on-disk root `package.json` this module guards. */
export const ROOT_PACKAGE_JSON_PATH = join(REPO_ROOT, 'package.json');

/**
 * The workspace root project's Nx name (see root `package.json#name`). It
 * has no `clean` target of its own — its `dist`-having descendants are
 * cleaned via `nx run-many`, so the root `clean` script must exclude it
 * from that fan-out (an `nx run-many --target=clean` that tried to include
 * it would fail: there is no such target on that project).
 */
export const WORKSPACE_ROOT_PROJECT_NAME = 'agentmonitors-workspace';

/** Directory names never worth descending into while discovering packages. */
const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.nx',
  '.claude',
  '.turbo',
  'dist',
  'temp',
  '.next',
]);

/**
 * Walk the real, on-disk repo tree and return every directory (relative to
 * `root`) that has its own `api-extractor.build.json` AND
 * `api-extractor.report.json` — the config pair that marks a published
 * package with a curated, rolled-up public API (see
 * `scripts/api-report-ci-wiring.mjs`'s `hasApiExtractorConfigs`, which this
 * mirrors but reaches by filesystem discovery instead of an existing
 * curated package list, so this guard has no dependency on that list
 * staying in sync).
 *
 * The repo root itself also carries both files (the shared base config
 * every package's own config `extends`), but is deliberately excluded: it
 * has no `check:api-report`/`build` scripts of its own, and its `clean`
 * script is the aggregate one validated by
 * `assertRootCleanRunsWorkspaceCleanAndReset`, not a per-package one.
 *
 * @param {string} [root]
 * @returns {string[]} relative paths, sorted
 */
export function findApiExtractorPackageDirs(root = REPO_ROOT) {
  const found = [];

  /** @param {string} dir */
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (
      dir !== root &&
      entries.some(
        (entry) => entry.isFile() && entry.name === 'api-extractor.build.json',
      ) &&
      entries.some(
        (entry) => entry.isFile() && entry.name === 'api-extractor.report.json',
      )
    ) {
      found.push(relative(root, dir));
      // Don't descend further — a package directory's own nested content
      // (e.g. a vendored fixture) is never itself a second package.
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIR_NAMES.has(entry.name)) {
        continue;
      }
      walk(join(dir, entry.name));
    }
  };

  walk(root);
  return found.sort();
}

/**
 * @typedef {'&&' | '||' | ';' | '\n' | '&'} ShellOperator
 */

/**
 * @typedef {{ words: string[] }} LexedCommand
 */

/**
 * @typedef {{ words: string[], guaranteed: boolean }} ChainedCommand
 */

/**
 * Lex a (deliberately narrow, non-pipe, non-subshell) shell script into a
 * flat stream alternating {@link LexedCommand} word-lists and
 * {@link ShellOperator} tokens — a SINGLE quote/escape/comment-aware pass.
 *
 * This replaces three previously separate passes (comment/continuation
 * stripping, then &&/||/;/newline splitting, then per-command whitespace
 * tokenizing), each of which needed the exact same quote/escape state to
 * tell an operator/comment/word-boundary apart from literal text but
 * couldn't share it — round-3 #454 review findings: escape-UNAWARE quote
 * tracking closed a double-quoted string early on `\"` (an escaped quote,
 * which real double-quote rules keep literal and open), and `#` was
 * recognized as a comment mid-word instead of only at the start of one. A
 * single pass with one shared quote/escape state can't develop that kind
 * of pass-to-pass drift.
 *
 * Scope, deliberately NOT full POSIX: no pipes (`|`), no subshells
 * (`(...)`), no command substitution, no parameter/glob expansion. This
 * guard only ever needs to classify the small set of shell forms that
 * appear in this repo's own `clean` scripts (`&&`/`||`/`;`/newline/`&`
 * -chained, optionally quoted `rm -rf`/`nx` invocations) — a
 * general-purpose shell parser would validate a far larger grammar than
 * this guard will ever exercise, at the cost of being much harder to
 * verify by inspection than this bounded, single-purpose lexer.
 *
 * Word rules implemented (POSIX `sh` quote-removal semantics, scoped to
 * the constructs above):
 * - Unquoted whitespace separates words.
 * - An unquoted `#` starts a comment to end-of-physical-line, but ONLY
 *   when it begins a word (preceded by whitespace, an operator, or the
 *   start of the script) — a `#` in the middle of a word (e.g.
 *   `temp#suffix`) is ordinary text, exactly as `/bin/sh` treats it.
 * - Inside `'...'`, every character (including `\`) is literal; there is
 *   no escaping.
 * - Inside `"..."`, characters are literal EXCEPT a backslash immediately
 *   before `"`, `\`, `$`, `` ` ``, or a newline — only those five are
 *   escapable inside double quotes, per POSIX; a backslash before any
 *   other character stays a literal backslash. A `\"` therefore keeps the
 *   quoted string OPEN (the quote is not closed by an escaped `"`).
 * - Outside quotes, a backslash escapes exactly the next character,
 *   stripping any special meaning it would otherwise have (including
 *   `;`/`&`/`|`/`#`/a quote character) — except a backslash immediately
 *   before a newline, which is a line CONTINUATION: both characters are
 *   discarded and the two physical lines become one logical line.
 * - `&&`, `||`, `;`, a bare newline, and a lone (non-`&&`) `&` are each
 *   unquoted control operators, recognized wherever they appear — not
 *   just at the end of a line/command (round-3 #454 review finding: a
 *   lone `&` was previously recognized only as the LAST character of the
 *   whole script, so `rm -rf dist temp & echo done` was accepted as one
 *   ordinary command instead of a backgrounded `rm -rf` followed by a
 *   fresh, unconditional `echo`).
 *
 * @param {string} script
 * @returns {(LexedCommand | ShellOperator)[]}
 */
function lexShellLike(script) {
  /** @type {(LexedCommand | ShellOperator)[]} */
  const out = [];
  /** @type {string[]} */
  let words = [];
  let word = '';
  let wordOpen = false;
  /** @type {"'" | '"' | undefined} */
  let quote;
  // Only used to decide whether an unquoted `#` starts a comment — true at
  // script start, right after whitespace, or right after an operator.
  let atWordStart = true;

  const flushWord = () => {
    if (wordOpen) {
      words.push(word);
      word = '';
      wordOpen = false;
    }
  };
  /** @param {ShellOperator} [operator] */
  const flushCommand = (operator) => {
    flushWord();
    if (words.length > 0) {
      out.push({ words });
    }
    words = [];
    if (operator !== undefined) {
      out.push(operator);
    }
    atWordStart = true;
  };

  for (let i = 0; i < script.length; i++) {
    const ch = script[i];

    if (quote === "'") {
      if (ch === "'") {
        quote = undefined;
      } else {
        word += ch;
      }
      wordOpen = true;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = undefined;
        wordOpen = true;
        continue;
      }
      const next = script[i + 1];
      if (ch === '\\' && next === '\n') {
        i++; // line continuation, even inside a double-quoted string
        continue;
      }
      if (
        ch === '\\' &&
        (next === '"' || next === '\\' || next === '$' || next === '`')
      ) {
        word += next;
        wordOpen = true;
        i++;
        continue;
      }
      // An UNESCAPED `$`/backtick inside a double-quoted string is real
      // parameter/command substitution syntax, not literal text — POSIX
      // `sh` expands it. This lexer's documented scope explicitly excludes
      // expansion (see the module doc), so rather than silently swallowing
      // it as inert text (which would let e.g. `"$flag"` accept whatever
      // literal argv the real shell expands it to, including a no-op
      // control flag — round-4 #454 review finding), fail closed: reject
      // the whole script as an unsupported construct.
      if (ch === '$' || ch === '`') {
        throw new Error(
          `unsupported shell construct in clean script: unescaped "${ch}" ` +
            `(parameter/command expansion) inside a double-quoted string is ` +
            `not supported by this guard's lexer — got: ${JSON.stringify(script)}`,
        );
      }
      word += ch;
      wordOpen = true;
      continue;
    }

    // Unquoted.
    if (ch === '\\') {
      if (script[i + 1] === '\n') {
        i++; // line continuation
        continue;
      }
      if (i + 1 < script.length) {
        word += script[i + 1];
        wordOpen = true;
        atWordStart = false;
        i++;
        continue;
      }
      // Trailing lone backslash at end of script: nothing to escape, keep
      // it as literal text rather than throwing it away.
      word += ch;
      wordOpen = true;
      atWordStart = false;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      wordOpen = true;
      atWordStart = false;
      continue;
    }

    // An unquoted/unescaped `$`/backtick is also real expansion syntax
    // outside quotes — same fail-closed rationale as the double-quoted
    // case above (round-4 #454 review finding: `flag=--help; rm -rf $flag
    // dist temp` would otherwise be lexed as the four literal words
    // `rm`/`-rf`/`$flag`/`dist`/`temp`, hiding the real expanded argv).
    if (ch === '$' || ch === '`') {
      throw new Error(
        `unsupported shell construct in clean script: unescaped "${ch}" ` +
          `(parameter/command expansion) is not supported by this guard's ` +
          `lexer — got: ${JSON.stringify(script)}`,
      );
    }

    // An unquoted/unescaped `<`/`>` is I/O redirection — out of this
    // lexer's documented scope (see the module doc) and, critically, NOT
    // safe to fold into a command's ordinary argv the way earlier code did
    // (round-5 #454 review finding): `rm -rf dist temp < /nonexistent`
    // would otherwise lex as the words `rm`/`-rf`/`dist`/`temp`/`</`
    // `nonexistent`, satisfying `isRmRfCommand` even though `/bin/sh` fails
    // the redirection (no such file) BEFORE `rm` ever runs, so nothing is
    // actually removed. Fail closed rather than silently accepting it.
    if (ch === '<' || ch === '>') {
      throw new Error(
        `unsupported shell construct in clean script: unescaped "${ch}" ` +
          `(I/O redirection) is not supported by this guard's lexer — got: ${JSON.stringify(script)}`,
      );
    }

    if (ch === '#' && atWordStart) {
      while (i < script.length && script[i] !== '\n') {
        i++;
      }
      i--; // let the newline itself still be seen as a separator below
      continue;
    }

    // A real carriage return is NOT shell whitespace — `/bin/sh` treats it as
    // an ordinary literal word character exactly like any other non-special
    // byte (round-6 #454 review finding): a JSON-sourced clean script whose
    // parsed value contains a literal `\r` (e.g. `rm -rf dist temp\rjunk`)
    // was previously split into separate `temp` and `junk` words by treating
    // `\r` like a space/tab, letting `temp` be recognized as removed even
    // though the real shell passes `temp\rjunk` as ONE operand and `rm`
    // leaves `temp/` untouched. Only space and tab are unquoted whitespace.
    if (ch === ' ' || ch === '\t') {
      flushWord();
      atWordStart = true;
      continue;
    }

    if (ch === '&' && script[i + 1] === '&') {
      flushCommand('&&');
      i++;
      continue;
    }

    if (ch === '|' && script[i + 1] === '|') {
      flushCommand('||');
      i++;
      continue;
    }

    if (ch === '&') {
      flushCommand('&');
      continue;
    }

    if (ch === ';') {
      flushCommand(';');
      continue;
    }

    if (ch === '\n') {
      flushCommand('\n');
      continue;
    }

    word += ch;
    wordOpen = true;
    atWordStart = false;
  }

  // A quote left open at end-of-script is a genuine shell syntax error —
  // `/bin/sh` itself rejects it (exit status 2) rather than treating the
  // rest of the (nonexistent) script as quoted text. Flushing the partial
  // word as though the quote had closed would instead silently accept
  // whatever commands happen to precede the unterminated quote as real,
  // executed commands (round-4 #454 review finding: `rm -rf dist temp "`
  // was accepted this way).
  if (quote !== undefined) {
    throw new Error(
      `unsupported/invalid shell syntax in clean script: unterminated ${quote === '"' ? 'double' : 'single'}-quoted string — got: ${JSON.stringify(script)}`,
    );
  }

  flushCommand();
  validateNoDanglingControlOperators(out);
  validateNoReservedCompoundSyntax(out);
  return out;
}

/**
 * Shell reserved words that introduce compound-command grammar (`if`/`for`/
 * `while`/`case`/function definitions/brace or subshell grouping) this
 * lexer's documented scope explicitly excludes — see the module doc's "Scope,
 * deliberately NOT full POSIX" paragraph. Recognizing only `&&`/`||`/`;`/
 * newline/`&` as control structure means a compound command is otherwise
 * accepted as if its reserved words were ordinary command words, hiding
 * conditional execution this guard has no model for (round-6 #454 review
 * finding): `if false; then\n rm -rf dist temp\nfi` lexes as the plain
 * commands `if false`, `rm -rf dist temp`, and `fi`, with the `rm -rf`
 * counted as unconditionally guaranteed even though it only runs when the
 * (here, always-false) `if` condition holds. Fail closed instead.
 */
const SHELL_RESERVED_WORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
  'in',
  '{',
  '}',
  '(',
  ')',
]);

/**
 * Fail closed if any lexed command's FIRST word is a
 * {@link SHELL_RESERVED_WORDS} entry — this bounded lexer never models the
 * compound-command grammar those words introduce (see
 * {@link SHELL_RESERVED_WORDS}'s doc), so treating them as an ordinary
 * command name would silently accept scripts whose actual execution is
 * conditional on a construct this guard can't reason about.
 *
 * Deliberately checked against ONLY the first word of each lexed command,
 * not every word: a reserved word is exclusively special in "command name"
 * position (the start of a new simple command or compound-command clause) —
 * every one of these words this lexer ever sees elsewhere in a command's
 * word list is ordinary argument TEXT, e.g. `echo done` (an entirely benign
 * `echo` invocation whose argument happens to be the literal string `done`)
 * must NOT be rejected the way `for x; do rm -rf dist temp; done` (where
 * `done` truly is the reserved word closing the loop, and is consequently
 * lexed as the FIRST word of its own command once split on the preceding
 * `;`) must be.
 *
 * @param {(LexedCommand | ShellOperator)[]} tokens
 */
function validateNoReservedCompoundSyntax(tokens) {
  for (const token of tokens) {
    if (typeof token !== 'object') {
      continue;
    }
    const head = token.words[0];
    if (head !== undefined && SHELL_RESERVED_WORDS.has(head)) {
      throw new Error(
        `unsupported shell construct in clean script: reserved word "${head}" ` +
          '(compound-command syntax such as if/for/while/case/function/' +
          "grouping) is not supported by this guard's lexer — got word list " +
          `${JSON.stringify(token.words)}`,
      );
    }
  }
}

/**
 * Fail closed on shell syntax this lexer's bounded grammar cannot make
 * sense of: a leading `&&`/`||`/lone-`&` (no preceding command for `&&`/
 * `||` to gate, or for a lone `&` to background), an `&&`/`||` left
 * trailing with nothing after it to gate (unlike `&&`/`||`, a TRAILING
 * lone `&` is ordinary, valid shell syntax — `rm -rf dist temp &` legally
 * backgrounds the preceding command as a complete statement with nothing
 * required after it), or two `&&`/`||`/`&` back-to-back with no real
 * command between them. `/bin/sh` itself rejects every one of these
 * (except the valid trailing `&`) with a syntax error rather than running
 * anything — silently ignoring them (as a naive split/flatten would)
 * accepts scripts where a required command is actually unreachable syntax
 * garbage, not a real guaranteed step (round-4 #454 review finding: both
 * `&& rm -rf dist temp` and `rm -rf dist temp &&` were accepted).
 *
 * A bare newline immediately before/after/between these is transparent —
 * it's benign whitespace (e.g. a blank line, or a real `&&`/`||`
 * continuation onto the next physical line — see
 * {@link splitChainedCommands}), not itself a command boundary.
 *
 * A `;`, unlike a newline, is NOT transparent here (round-5 #454 review
 * finding): it is itself a statement separator that requires a real
 * preceding command to terminate, exactly like `&&`/`||`/`&` do — `/bin/sh
 * -n` rejects both a LEADING `;` (`; rm -rf dist temp` — nothing precedes
 * it to separate) and a `;` immediately after a pending `&&`/`||`
 * (`true &&; rm -rf dist temp` — the semicolon can't complete that
 * operator's right-hand side) with a syntax error, but earlier code
 * treated `;` identically to a benign newline in both positions and
 * accepted them.
 *
 * This validates every "gap" — the run of operator tokens between two
 * consecutive commands, or before the first/after the last command — against
 * the POSIX grammar's `separator`/`and_or` productions (round-6 #454 review
 * finding): a gap containing `&&`/`||` is valid ONLY if that operator is the
 * gap's very FIRST token (nothing, not even a `;` or a newline, may separate
 * it from the command it chains off of) and only bare newlines follow it —
 * `/bin/sh -n` rejects both `true; && echo hi` (a `;` before the `&&`) and a
 * `&&`/`||` on its own line after a fully-terminated previous statement
 * (`true\n&& echo hi`), which earlier code (checking only immediate
 * token-to-token adjacency) accepted. A gap containing no `&&`/`||` (just
 * `;`/`&`/newlines) is valid only if it has AT MOST ONE non-newline token,
 * and — when present — that token is the gap's first token (a newline
 * before it means the previous statement was already fully terminated, so
 * the separator has nothing left to terminate): `/bin/sh -n` rejects both
 * `rm -rf dist temp;;` (two `;` with no command between) and
 * `echo hi\n;` (a `;` stranded after an already-terminating newline),
 * which earlier code — only ever comparing a token to its IMMEDIATE
 * predecessor/successor rather than validating the whole gap — accepted.
 *
 * @param {(LexedCommand | ShellOperator)[]} tokens
 */
function validateNoDanglingControlOperators(tokens) {
  /** @param {ShellOperator | undefined} token */
  const isAndOr = (token) => token === '&&' || token === '||';

  /**
   * @param {ShellOperator[]} gap
   * @param {boolean} hasPrecedingCommand
   * @param {boolean} hasFollowingCommand
   */
  const validateGap = (gap, hasPrecedingCommand, hasFollowingCommand) => {
    if (gap.length === 0) {
      return;
    }

    const andOrIndex = gap.findIndex(isAndOr);
    if (andOrIndex !== -1) {
      const operator = gap[andOrIndex];
      if (andOrIndex !== 0) {
        throw new Error(
          `invalid shell syntax in clean script: "${operator}" is not ` +
            'immediately preceded by a command — a separator or newline ' +
            'from an already-terminated statement appears between them',
        );
      }
      const extra = gap.slice(1).find((candidate) => candidate !== '\n');
      if (extra !== undefined) {
        throw new Error(
          `invalid shell syntax in clean script: "${operator}" immediately ` +
            `followed by "${extra}" with no command between them`,
        );
      }
      if (!hasPrecedingCommand) {
        throw new Error(
          `invalid shell syntax in clean script: begins with a dangling ` +
            `"${operator}" operator with no preceding command`,
        );
      }
      if (!hasFollowingCommand) {
        throw new Error(
          `invalid shell syntax in clean script: ends with a dangling ` +
            `"${operator}" operator with no following command`,
        );
      }
      return;
    }

    // No `&&`/`||` in this gap: just `;`/`&`/newlines. POSIX allows at most
    // ONE `;`/`&` separator between two commands, and it must precede any
    // newlines in the gap (a newline BEFORE it means the previous statement
    // was already terminated on its own, leaving the separator dangling).
    const separators = gap.filter((token) => token === ';' || token === '&');
    if (separators.length > 1) {
      throw new Error(
        'invalid shell syntax in clean script: multiple statement ' +
          `separators (${separators.map((token) => `"${token}"`).join(', ')}) ` +
          'with no command between them',
      );
    }
    if (separators.length === 1) {
      const separator = separators[0];
      if (gap[0] !== separator) {
        throw new Error(
          `invalid shell syntax in clean script: "${separator}" separator ` +
            'preceded by a newline from an already-terminated statement, ' +
            'with no command between them',
        );
      }
      if (!hasPrecedingCommand) {
        throw new Error(
          `invalid shell syntax in clean script: begins with a dangling ` +
            `"${separator}" separator with no preceding command`,
        );
      }
      // A trailing `;`/`&` (unlike a trailing `&&`/`||`) IS valid, ordinary
      // shell syntax (`echo hi;`/`echo hi &` both terminate a real preceding
      // command with nothing required after them).
    }
  };

  /** @type {number[]} */
  const commandIndices = [];
  tokens.forEach((token, index) => {
    if (typeof token === 'object') {
      commandIndices.push(index);
    }
  });

  const firstCommandIndex =
    commandIndices.length > 0 ? commandIndices[0] : tokens.length;
  validateGap(
    /** @type {ShellOperator[]} */ (tokens.slice(0, firstCommandIndex)),
    false,
    commandIndices.length > 0,
  );

  for (let i = 0; i + 1 < commandIndices.length; i++) {
    validateGap(
      /** @type {ShellOperator[]} */ (
        tokens.slice(commandIndices[i] + 1, commandIndices[i + 1])
      ),
      true,
      true,
    );
  }

  if (commandIndices.length > 0) {
    const lastCommandIndex = commandIndices[commandIndices.length - 1];
    validateGap(
      /** @type {ShellOperator[]} */ (tokens.slice(lastCommandIndex + 1)),
      true,
      false,
    );
  }
}

/**
 * Strip a leading run of POSIX assignment words (`NAME=value`) off a
 * command's word list — e.g. `skipLeadingAssignments(['X=1', 'exit', '0'])`
 * returns `['exit', '0']`. POSIX `sh` allows any number of `NAME=value`
 * words to prefix a simple command (they set that variable in the
 * command's environment, or — for a special builtin like `exit` — persist
 * in the shell itself), so `X=1 exit 0` still runs `exit` exactly like a
 * bare `exit 0` would (round-5 #454 review finding: `isExitCommand`/
 * `commandAlwaysFails` only ever checked `words[0]` directly, so an
 * assignment-prefixed `X=1 exit 0 && rm -rf dist temp` looked like an
 * ordinary, non-terminating command instead of a script-terminating one).
 *
 * @param {string[]} words
 * @returns {string[]}
 */
function skipLeadingAssignments(words) {
  let index = 0;
  while (
    index < words.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])
  ) {
    index++;
  }
  return words.slice(index);
}

/**
 * Whether a command's word list is one this guard knows the exit status of
 * without running it. Only "always fails" matters in practice: it lets an
 * adversarial `false && required-command` (or `exit 1 && required-command`)
 * chain look identical to a `guaranteed: true` chain to logic that
 * (correctly, for every real `rm -rf`/`nx` invocation this guard validates)
 * optimistically assumes an unrecognized command succeeds.
 *
 * @param {string[]} words
 * @returns {boolean}
 */
function commandKnownStatus(words) {
  const [head, ...rest] = skipLeadingAssignments(words);
  if (head === undefined) {
    return 'unknown';
  }
  // Any invocation of the `false` utility deterministically fails,
  // regardless of its path form (`false`, `/bin/false`, `/usr/bin/false`,
  // `./vendor/false`, …) or any (ignored) trailing arguments — round-5 #454
  // review finding: only the bare literal word `false` was recognized, so
  // `/usr/bin/false && rm -rf dist temp` looked exactly like a real
  // guaranteed chain even though `/usr/bin/false` fails identically to the
  // builtin.
  if (head.split('/').pop() === 'false') {
    return 'fail';
  }
  // `exit <nonzero literal>` deterministically fails the same way — round-3
  // #454 review finding: only recognizing the literal `false` builtin left
  // `exit 1 && rm -rf dist temp` (which never actually removes anything)
  // indistinguishable from a real guaranteed chain.
  if (head === 'exit' && rest.length === 1 && /^-?\d+$/.test(rest[0])) {
    return Number(rest[0]) !== 0 ? 'fail' : 'success';
  }
  // Utility command names this guard trusts to succeed when actually
  // reached — every real invocation this guard itself validates (`rm -rf`,
  // any `nx` subcommand) plus the trivially-always-successful POSIX
  // builtins `true` and `:`. Any OTHER command's status is `'unknown'`
  // (round-6 #454 review finding): optimistically treating every
  // unrecognized command as successful let an adversarial
  // `<unrecognized-command> && required-command` chain (e.g.
  // `/bin/sh -c "exit 1" && rm -rf dist temp`, whose OWN nested exit status
  // this lexer's bounded grammar can't evaluate) look identical to a real
  // `guaranteed: true` chain, even though this guard has no actual basis for
  // assuming that command's outcome.
  if (head === 'rm' || head === 'nx' || head === 'true' || head === ':') {
    return 'success';
  }
  return 'unknown';
}

/**
 * Whether a command's word list is `exit` or `exec <command...>`, ignoring
 * any leading assignment-word prefix (see {@link skipLeadingAssignments}).
 * Distinct from {@link commandKnownStatus}: a terminating command's defining
 * effect isn't its exit STATUS (an `exit 0` succeeds exactly like any other
 * successful command) — it's that a REACHED `exit`/`exec` terminates the
 * whole script immediately, so nothing chained after it (via `&&`, `||`,
 * `;`, a newline, or `&`) ever runs, regardless of that command's own
 * operator (round-4 #454 review finding: `exit 0 && rm -rf dist temp` and
 * `exit 0 && <run-many> && <reset>` were both accepted, because a
 * zero-status `exit` looked identical to any other successful command to
 * logic that only tracked `lastStatus`; round-6 #454 review finding:
 * `exec /usr/bin/false; rm -rf dist temp` was accepted the same way, since
 * `exec` wasn't recognized as terminating at all).
 *
 * @param {string[]} words
 * @returns {boolean}
 */
function isTerminatingCommand(words) {
  const stripped = skipLeadingAssignments(words);
  if (stripped[0] === 'exit') {
    return true;
  }
  // `exec <command...>` REPLACES the current shell process with the given
  // command rather than returning to it, so — like a reached `exit` —
  // anything chained after it in the ORIGINAL script never runs, no matter
  // whether the exec'd command itself succeeds or fails (round-6 #454
  // review finding: `exec /usr/bin/false; rm -rf dist temp` was previously
  // accepted, because `exec ...` looked like any other ordinary,
  // non-terminating command). A bare `exec` with no following words merely
  // applies redirections to the current shell and does NOT terminate.
  return stripped[0] === 'exec' && stripped.length > 1;
}

/**
 * Split a shell script string into its individual chained commands (on
 * `&&`, `||`, `;`, a newline, or a lone `&`), each tagged with whether it
 * is `guaranteed` to run.
 *
 * `guaranteed` models a single, deterministic execution path: every
 * command this guard doesn't specifically recognize (see
 * {@link commandKnownStatus}) is optimistically assumed to succeed (true
 * for every real `rm -rf`/`nx` invocation this guard validates), and the
 * resulting exit status is carried forward as `lastStatus` — INCLUDING
 * across a skipped command, whose own (never-executed) status must never
 * overwrite it. `&&` only runs its right-hand command when `lastStatus` is
 * `'success'`; `||` only when it's `'fail'`; `;`/newline/`&` don't gate
 * anything — the following command always runs, on a fresh, unconditional
 * chain.
 *
 * This single `lastStatus` — rather than each command's OWN immediately
 * preceding reachability — is what makes `&&`/`||` genuinely left-
 * associative with equal precedence, matching real POSIX shell semantics
 * (round-3 #454 review finding, `adaptive-parser-001`): given
 * `cmd1 || cmd2 && cmd3`, if `cmd1` succeeds, `cmd2` is skipped but `cmd3`
 * still runs — its `&&` looks back through the skip to `cmd1`'s status,
 * not to `cmd2`'s (which never executed). A model that instead tracked
 * only "was the IMMEDIATELY PRECEDING command guaranteed-and-successful"
 * would wrongly reject that reachable `cmd3`.
 *
 * A lone `&` (background — distinct from `&&`) marks the command
 * immediately before it `guaranteed: false` regardless of its own
 * reachability, since the shell does not wait for a backgrounded command
 * to complete before continuing — e.g. `rm -rf dist temp &` is never a
 * reliable removal — and then behaves like `;`/newline for what follows:
 * an unconditional, freshly-reachable next command (round-3 #454 review
 * finding, `adaptive-parser-002`: a lone `&` was previously recognized
 * only as the LAST character of the whole script, so a mid-chain
 * `rm -rf dist temp & echo done` was accepted as a single, non-backgrounded
 * command).
 *
 * A REACHED terminating command (see {@link isTerminatingCommand}, `exit`
 * or `exec <command...>`) terminates the whole script: every command
 * chained after it — via ANY operator, not just `&&`/`||` — never runs, so
 * all of them are pushed `guaranteed: false` regardless of what their own
 * operator would otherwise imply (round-4 #454 review finding: `exit 0 &&
 * rm -rf dist temp` was previously accepted, because `exit 0`'s zero status
 * looked exactly like any other successful command's; round-6 #454 review
 * finding: `exec /usr/bin/false; rm -rf dist temp` was accepted the same
 * way) — EXCEPT when the terminating command's own AND/OR list is
 * backgrounded by a lone `&`: that forks the WHOLE list into a background
 * SUBSHELL, and a special builtin or `exec` running inside a subshell only
 * ends the subshell, not the main script. Whether the list is backgrounded
 * isn't known until its terminator is seen, so a terminating command's
 * whole-script effect is DEFERRED across the rest of its list rather than
 * confirmed the instant the next token appears (round-6 #454 review
 * finding): `exit 0 & rm -rf dist temp` (the terminating command backgrounded
 * on its own) AND `exit 0 && true & rm -rf dist temp` (the whole
 * `exit 0 && true` list backgrounded, with the foreground `rm` still running
 * unconditionally afterwards) are both correctly accepted, where an earlier
 * version — treating the `&&` after `exit` as immediately confirming
 * termination, before the later `&` revealed the list was asynchronous —
 * wrongly REJECTED the second. Within the terminating command's own list,
 * every LATER command is `guaranteed: false` either way (a foreground
 * `exit`/`exec` never returns to them; a backgrounded list is non-guaranteed
 * regardless).
 *
 * A lone `&` backgrounds the ENTIRE preceding AND/OR list (every command
 * chained by `&&`/`||` since the last unconditional `;`/newline/`&`
 * boundary), not merely the single command immediately before it — POSIX
 * backgrounds the whole compound list as one asynchronous job (round-4
 * #454 review finding: `rm -rf dist temp && echo done & echo next` only
 * marked `echo done` non-guaranteed, leaving the earlier `rm -rf dist temp`
 * wrongly counted as guaranteed even though it's part of the same
 * backgrounded list and may still be running when the foreground
 * continuation proceeds).
 *
 * Mirrors the split delimiters (though not the guaranteed/unguaranteed
 * distinction) in `api-report-ci-wiring.mjs`'s `splitChainedCommands` —
 * kept local so this module has no import-time dependency on that one's
 * internals.
 *
 * @param {string} script
 * @returns {ChainedCommand[]}
 */
function splitChainedCommands(script) {
  /** @type {ChainedCommand[]} */
  const commands = [];
  /** @type {'&&' | '||' | undefined} */
  let pendingOperator;
  // `'unknown'` (round-6 #454 review finding) models a command whose exit
  // status this guard has no basis for assuming — neither `&&` nor `||`
  // ever treats a following command as `guaranteed` off an `'unknown'`
  // predecessor, since the real shell might take either branch.
  /** @type {'success' | 'fail' | 'unknown'} */
  let lastStatus = 'success'; // vacuous: only consulted once a command has run
  // Index (into `commands`) where the CURRENT AND/OR list began — every
  // command from here to the end is chained by `&&`/`||` off one another,
  // with no intervening unconditional `;`/newline/`&` boundary. Reset to
  // `commands.length` every time a command starts a fresh, unconditional
  // statement, so a lone `&` can background the whole list at once.
  let currentListStart = 0;
  // Once a REACHED, FOREGROUND terminating command (see
  // {@link isTerminatingCommand} — `exit` or `exec <command...>`) is
  // CONFIRMED to terminate the script (see `listTerminationPending` below),
  // every command in a LATER list (however it's chained) never runs.
  let scriptTerminated = false;
  // A reached terminating command occurred in the CURRENT AND/OR list, but
  // whether it terminates the whole SCRIPT isn't known until that list's
  // terminator is seen — round-5/round-6 #454 review finding. While pending,
  // it already makes every LATER command in the same list unreachable (a
  // foreground `exit`/`exec` never returns to them; a backgrounded list
  // marks them non-guaranteed anyway). It resolves when the list ends:
  // - terminator `&` → the whole list ran in a background SUBSHELL, so a
  //   special builtin or `exec` inside it only ends that subshell, not the
  //   main script (round-5: `exit 0 & rm -rf dist temp` still runs `rm`) —
  //   cleared WITHOUT setting `scriptTerminated`. This deferral is what makes
  //   `exit 0 && true & rm -rf dist temp` (the whole `exit 0 && true` list
  //   backgrounded, foreground `rm` still runs) correctly accepted, rather
  //   than treated as terminated the instant the `&&` after `exit` is seen.
  // - terminator `;`/newline/end-of-script (a real foreground list boundary,
  //   NOT a `&&`/`||` continuation) → it ran in the foreground and did
  //   terminate the script, so `scriptTerminated` is set.
  let listTerminationPending = false;

  for (const token of lexShellLike(script)) {
    if (token === ';' || token === '\n') {
      // A `;`/newline that is NOT continuing a still-pending `&&`/`||` (e.g.
      // the newline right after `||` in `dist ||\ntemp`, which is benign
      // whitespace within that operator's continuation) genuinely ends the
      // current foreground AND/OR list. If that list reached a terminating
      // command, the script really did terminate here.
      if (pendingOperator === undefined && listTerminationPending) {
        scriptTerminated = true;
        listTerminationPending = false;
      }
      continue;
    }

    if (token === '&') {
      // Background the WHOLE current AND/OR list (every command since
      // `currentListStart`), then behave exactly like `;`/newline for what
      // follows: the next command starts a fresh, unconditional statement.
      // `listTerminationPending` is deliberately cleared WITHOUT setting
      // `scriptTerminated` — see its declaration.
      listTerminationPending = false;
      for (let i = currentListStart; i < commands.length; i++) {
        commands[i].guaranteed = false;
      }
      pendingOperator = undefined;
      currentListStart = commands.length;
      continue;
    }

    if (token === '&&' || token === '||') {
      // Only record a NEW pending operator if there isn't already one
      // awaiting a real command, for the same empty-segment reason noted
      // above for `;`/newline.
      pendingOperator ??= token;
      continue;
    }

    const { words } = token;

    let reachable;
    if (scriptTerminated || listTerminationPending) {
      // Nothing after a reached terminating command ever runs on the
      // foreground path — whether it terminated a prior list
      // (`scriptTerminated`) or is earlier in THIS list
      // (`listTerminationPending`), and regardless of this command's own
      // operator. (A command later backgrounded by a `&` is marked
      // non-guaranteed by that `&` branch anyway, so forcing it here is
      // consistent either way.)
      reachable = false;
    } else if (pendingOperator === '&&') {
      reachable = lastStatus === 'success';
    } else if (pendingOperator === '||') {
      reachable = lastStatus === 'fail';
    } else {
      reachable = true; // first command, or a fresh `;`/newline/`&` statement
      currentListStart = commands.length; // this command starts a new list
    }

    commands.push({ words, guaranteed: reachable });

    if (reachable) {
      lastStatus = commandKnownStatus(words);
      if (isTerminatingCommand(words)) {
        listTerminationPending = true;
      }
    }
    // If NOT reachable (this command was skipped), `lastStatus` carries
    // forward UNCHANGED — see the function doc for why.
    pendingOperator = undefined;
  }

  return commands;
}

/**
 * Whether a command's word list begins with exactly the given word
 * sequence, e.g. `startsWithTokens(['NX_TUI=false','nx','reset'],
 * 'NX_TUI=false', 'nx', 'reset')`. Exact per-word comparison, not a
 * `\b`-bounded regex, so a `reset-old` word can never satisfy a check for
 * the `reset` word.
 *
 * @param {string[]} words
 * @param {...string} expectedWords
 * @returns {boolean}
 */
function startsWithTokens(words, ...expectedWords) {
  return expectedWords.every((expected, index) => words[index] === expected);
}

/**
 * Whether a command's word list contains the given word sequence
 * contiguously anywhere within it (not just at the start) — e.g.
 * `containsTokens(['NX_TUI=false','nx','reset'], 'nx', 'reset')`. Exact
 * per-word comparison for the same reason as {@link startsWithTokens}.
 *
 * @param {string[]} words
 * @param {...string} expectedWords
 * @returns {boolean}
 */
function containsTokens(words, ...expectedWords) {
  for (let start = 0; start + expectedWords.length <= words.length; start++) {
    if (
      expectedWords.every(
        (expected, offset) => words[start + offset] === expected,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extract the raw values of EVERY exact `--flagName=value` word in a
 * command's words (a repeatable flag like `nx run-many --exclude=` may
 * legitimately appear more than once — `--exclude=a --exclude=b` excludes
 * BOTH `a` and `b`). Exact flag-name match only — deliberately not a
 * `\b`-bounded regex, which matches a word boundary right before a hyphen
 * and so would wrongly treat `--target=clean-old` as satisfying a check for
 * `--target=clean` (issue #443 post-merge review).
 *
 * @param {string[]} words
 * @param {string} flagName
 * @returns {string[]} raw values, one per occurrence, in word order
 */
function findFlagValues(words, flagName) {
  const prefix = `--${flagName}=`;
  return words
    .filter((candidate) => candidate.startsWith(prefix))
    .map((word) => word.slice(prefix.length));
}

/**
 * Every comma-separated member across ALL occurrences of a `--flagName=`
 * word, flattened into a single set — e.g. two `--exclude=a --exclude=b`
 * words, or one `--target=clean,other` word, both yield the full
 * membership the flag actually carries. A single occurrence's own value is
 * ALSO comma-split, since a real `nx` flag like `--target=` accepts a
 * comma-joined list in one word (issue #443 post-merge review: an earlier
 * exact-equality check against a single occurrence's raw value false-
 * rejected `--target=clean,other` and never merged repeated `--exclude=`
 * occurrences at all).
 *
 * @param {string[]} words
 * @param {string} flagName
 * @returns {Set<string>}
 */
function findFlagValueSet(words, flagName) {
  return new Set(
    findFlagValues(words, flagName).flatMap((value) => value.split(',')),
  );
}

/**
 * Flags that make the real `nx` CLI print help/usage text (or otherwise
 * skip actually running the target) and exit 0 without performing the
 * work — so a command carrying one of these is a no-op impersonating a
 * real `nx run-many --target=clean`/`nx reset` invocation (round-2 #454
 * review finding: `nx run-many --target=clean ... --help && nx reset
 * --help` was accepted even though `nx` prints help and returns for both,
 * running neither the per-project clean nor the cache reset). Compared
 * against already quote-removed words (see {@link lexShellLike}), so a
 * quoted `"--help"` is caught exactly like an unquoted one (round-3 #454
 * review finding, `adaptive-parser-005`: comparing quote-PRESERVING source
 * text let a quoted control flag slip past, even though real shell quote
 * removal passes the exact same argv token `nx` itself acts on).
 */
const NX_NOOP_FLAGS = new Set(['--help', '-h', '--dry-run']);

/**
 * Whether a command's words carry any {@link NX_NOOP_FLAGS} entry — exact
 * per-word match, same rationale as {@link startsWithTokens}.
 *
 * @param {string[]} words
 * @returns {boolean}
 */
function hasNxNoopFlag(words) {
  return words.some((word) => NX_NOOP_FLAGS.has(word));
}

/**
 * Whether a command is an `nx run-many --target=clean` invocation, using
 * exact word/flag-value matching (see {@link findFlagValueSet}) rather
 * than a `\b`-bounded regex. `--target=` accepts a comma-joined list
 * (`--target=clean,other`), so this checks `clean` is a MEMBER of that set,
 * not that the raw value is exactly `"clean"`. Also rejects a
 * {@link NX_NOOP_FLAGS} invocation masquerading as the real thing.
 *
 * @param {string[]} words
 * @returns {boolean}
 */
function isNxRunManyCleanCommand(words) {
  return (
    containsTokens(words, 'nx', 'run-many') &&
    findFlagValueSet(words, 'target').has('clean') &&
    !hasNxNoopFlag(words)
  );
}

/**
 * Whether a command is exactly an `rm -rf` invocation (`rm` then `-rf` as
 * separate, exact words) with no further control/option flags among its
 * remaining words — not a `\b`-bounded regex, which matches a word
 * boundary right before a hyphen and so wrongly accepted `rm -rf-old dist
 * temp` as an `rm -rf` call (round-2 #454 review finding: `rm` itself
 * rejects `-rf-old` as an unsupported option and removes nothing).
 *
 * The trailing-flag check closes a related hole (round-3 #454 review
 * finding, `adaptive-parser-006`): `rm -rf --help dist temp` and
 * `rm -rf --version dist temp` both satisfy `rm`/`-rf` exactly, but the
 * real `rm` binary exits after printing control output instead of
 * deleting anything — so a bare `-`-prefixed word anywhere among the
 * "targets" makes this reject the command rather than count `dist`/`temp`
 * as removed.
 *
 * @param {string[]} words
 * @returns {boolean}
 */
function isRmRfCommand(words) {
  return (
    startsWithTokens(words, 'rm', '-rf') &&
    words.slice(2).every((word) => !word.startsWith('-'))
  );
}

/**
 * @typedef {{ scripts?: Record<string, string> }} PackageJson
 */

/**
 * Validate that a single package's `clean` script removes BOTH `dist` and
 * the api-extractor scratch dir `temp` — not just `dist` (the pre-#443
 * shape, restored to a `rm -rf dist`-only script, silently reopens the gap
 * this fix closed: `check:api-report`/`fix:api-report`'s `temp/` scratch
 * dir accumulates forever and agents fall back to hand-running a raw
 * `rm -rf dist temp`, forcing a permission prompt every time).
 *
 * @param {PackageJson} pkg
 * @param {string} label - identifies the package in thrown errors (e.g. its package.json path)
 */
export function assertPackageCleanRemovesDistAndTemp(pkg, label) {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') {
    throw new Error(`${label} has no top-level "scripts" section`);
  }

  const clean = scripts.clean;
  if (typeof clean !== 'string') {
    throw new Error(`${label} is missing a "clean" script`);
  }

  // Only commands `guaranteed` to run count toward the contract — a
  // `rm -rf temp` reachable only via `rm -rf dist || rm -rf temp` does NOT
  // reliably remove `temp`, since a successful `rm -rf dist` (the normal
  // case) skips it entirely.
  const rmCommandWords = splitChainedCommands(clean)
    .filter((entry) => entry.guaranteed && isRmRfCommand(entry.words))
    .map((entry) => entry.words);
  if (rmCommandWords.length === 0) {
    throw new Error(
      `${label} "clean" script must run \`rm -rf\` unconditionally (not only ` +
        `after a prior command fails via \`||\`) — got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }

  const removedTargets = new Set(
    rmCommandWords.flatMap((words) => words.slice(2)),
  );

  if (!removedTargets.has('dist')) {
    throw new Error(
      `${label} "clean" script must remove "dist" — got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }
  if (!removedTargets.has('temp')) {
    throw new Error(
      `${label} "clean" script must also remove "temp" (the api-extractor ` +
        `check:api-report/fix:api-report scratch dir), not just "dist" — ` +
        `got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }
}

/**
 * Validate that the root `clean` script (1) fans a `clean` target out
 * across every project via `nx run-many --target=clean`, excluding the
 * workspace root project (which has no `clean` target of its own), and (2)
 * afterwards resets the Nx cache/daemon via `nx reset` — with
 * `NX_TUI=false` scoped to EACH of those two invocations individually,
 * rather than a single shared `NX_TUI=false` prefix that only actually
 * covers the first command in the chain. A shared prefix looks identical
 * in a shell (`NX_TUI=false nx run-many ... && nx reset` still runs both
 * commands), but leaves `nx reset` unscoped the moment anyone reorders or
 * lifts the second command out of that exact chain (e.g. into its own npm
 * script), silently reintroducing the Nx TUI on that invocation.
 *
 * @param {PackageJson} pkg
 */
export function assertRootCleanRunsWorkspaceCleanAndReset(pkg) {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') {
    throw new Error('root package.json has no top-level "scripts" section');
  }

  const clean = scripts.clean;
  if (typeof clean !== 'string') {
    throw new Error('root package.json is missing a "clean" script');
  }

  // Only `guaranteed` commands count — `nx run-many ... || nx reset` does
  // NOT reliably reset the cache, since a successful run-many (the normal
  // case) skips the `nx reset` entirely.
  const commands = splitChainedCommands(clean).filter(
    (entry) => entry.guaranteed,
  );

  const runManyIndex = commands.findIndex((entry) =>
    isNxRunManyCleanCommand(entry.words),
  );
  if (runManyIndex === -1) {
    throw new Error(
      'root "clean" script must invoke `nx run-many --target=clean` ' +
        'unconditionally (not only after a prior command fails via `||`) to ' +
        `fan the per-project clean out across the workspace — got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }
  const runManyWords = commands[runManyIndex].words;

  const excludedProjects = findFlagValueSet(runManyWords, 'exclude');
  if (!excludedProjects.has(WORKSPACE_ROOT_PROJECT_NAME)) {
    throw new Error(
      'root "clean" script\'s `nx run-many --target=clean` must exclude ' +
        `"${WORKSPACE_ROOT_PROJECT_NAME}" (the workspace root project has no ` +
        `"clean" target of its own) — got: ${JSON.stringify(runManyWords.join(' '))} (issue #443)`,
    );
  }
  if (!startsWithTokens(runManyWords, 'NX_TUI=false', 'nx', 'run-many')) {
    throw new Error(
      'root "clean" script\'s `nx run-many --target=clean` invocation must ' +
        `itself be scoped with "NX_TUI=false" — got: ${JSON.stringify(runManyWords.join(' '))} (issue #443)`,
    );
  }

  const resetIndex = commands.findIndex(
    (entry) =>
      containsTokens(entry.words, 'nx', 'reset') && !hasNxNoopFlag(entry.words),
  );
  if (resetIndex === -1) {
    throw new Error(
      'root "clean" script must also run `nx reset` unconditionally (not ' +
        'only after a prior command fails via `||`) after the per-project ' +
        `clean, to reset the Nx cache/daemon — got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }
  const resetWords = commands[resetIndex].words;

  if (resetIndex < runManyIndex) {
    throw new Error(
      'root "clean" script must run `nx reset` AFTER `nx run-many ' +
        `--target=clean\`, not before — got: ${JSON.stringify(clean)} (issue #443)`,
    );
  }

  if (!startsWithTokens(resetWords, 'NX_TUI=false', 'nx', 'reset')) {
    throw new Error(
      'root "clean" script\'s `nx reset` invocation must itself be scoped ' +
        'with "NX_TUI=false" — a shared prefix earlier in the chain does ' +
        `not count once the commands are reordered or split — got: ${JSON.stringify(resetWords.join(' '))} (issue #443)`,
    );
  }
}
