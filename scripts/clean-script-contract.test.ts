/**
 * Tests for the workspace `clean` script contract guard (issue #443).
 *
 * Before this guard existed, nothing in CI ever invoked `pnpm clean` (it
 * has no build/type-check/test side effect that any other check could
 * catch), so the contract had zero regression protection: a package's
 * `clean` script could silently regress to a `dist`-only `rm -rf` (losing
 * the api-extractor `temp/` scratch-dir cleanup), or the root `clean`
 * script could lose its `nx reset` step or its `NX_TUI=false` scoping,
 * and nothing would fail.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  ROOT_PACKAGE_JSON_PATH,
  WORKSPACE_ROOT_PROJECT_NAME,
  assertPackageCleanRemovesDistAndTemp,
  assertRootCleanRunsWorkspaceCleanAndReset,
  findApiExtractorPackageDirs,
} from './clean-script-contract.mjs';

describe('findApiExtractorPackageDirs', () => {
  it('discovers every real, on-disk package with an api-extractor config pair', () => {
    const found = findApiExtractorPackageDirs();
    // Not a hardcoded expectation of "the six package names" — just proof
    // that discovery actually finds something, and that it excludes both
    // the repo root (which carries the shared base config but no scripts
    // of its own) and a package with no api-extractor configs at all.
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain('libs/core');
    expect(found).not.toContain('.');
    expect(found).not.toContain('apps/cli');
  });

  it('does not descend into ignored directories (sanity: no node_modules hits)', () => {
    const found = findApiExtractorPackageDirs();
    expect(found.some((dir) => dir.includes('node_modules'))).toBe(false);
  });
});

describe('assertPackageCleanRemovesDistAndTemp', () => {
  // Negative fixture #1: the pre-#443 shape — a package clean script that
  // removes only `dist`, exactly what every api-extractor package's
  // `clean` script looked like before this fix.
  it('rejects a "clean" script that only removes dist (pre-#443 shape)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist' } },
        'test-package',
      ),
    ).toThrow(/must also remove "temp"/);
  });

  // Negative fixture #3: a hypothetical FUTURE api-extractor package that
  // was scaffolded without ever adopting the temp-cleaning convention —
  // proves the guard rejects this drift shape wherever it appears, not
  // just in the specific packages that existed when #443 landed.
  it('rejects a future api-extractor package scaffolded with a dist-only clean', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        {
          scripts: {
            'check:api-report':
              'api-extractor run -c api-extractor.report.json',
            build: 'tsup && api-extractor run -c api-extractor.build.json',
            clean: 'rm -rf dist',
          },
        },
        'plugins/source-hypothetical-future',
      ),
    ).toThrow(/must also remove "temp"/);
  });

  it('rejects a package missing a "clean" script entirely', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp({ scripts: {} }, 'test-package'),
    ).toThrow(/is missing a "clean" script/);
  });

  it('rejects a "clean" script that removes temp but not dist', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf temp' } },
        'test-package',
      ),
    ).toThrow(/must remove "dist"/);
  });

  it('rejects a "clean" script that never runs `rm -rf` at all', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'echo not a real clean' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  it('accepts a correctly-shaped "clean" script (positive control)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist temp' } },
        'test-package',
      ),
    ).not.toThrow();
  });

  it('accepts dist and temp removed via separate chained rm -rf commands', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist && rm -rf temp' } },
        'test-package',
      ),
    ).not.toThrow();
  });

  // Regression fixture for the post-#443 review finding: `||` means "only
  // run if the previous command FAILED", so `rm -rf dist || rm -rf temp`
  // does NOT reliably remove `temp` — a successful `rm -rf dist` (the
  // normal case) skips the second command entirely. The pre-fix guard
  // flattened `&&` and `||` identically and wrongly accepted this.
  it('rejects "temp" removed only via `|| rm -rf temp` (guard false-accept #1)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist || rm -rf temp' } },
        'test-package',
      ),
    ).toThrow(/must also remove "temp"/);
  });

  // Regression fixture for the post-#454 review finding: splitting on
  // `/(&&|\|\||;|\n)/` yields an EMPTY command segment between `||` and an
  // immediately following newline (`"rm -rf dist ||\nrm -rf temp"` splits
  // to `['rm -rf dist ', '||', '', '\n', 'rm -rf temp']`). The pre-fix
  // guard's operator-token branch unconditionally overwrote
  // `precedingOperator` with that newline, discarding the pending `||` and
  // wrongly marking the `rm -rf temp` guaranteed — even though a real shell
  // still treats the newline as part of the `||` continuation and skips
  // the second command whenever the first succeeds.
  it('rejects "temp" removed only via `||` immediately followed by a newline (guard false-accept #3)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist ||\nrm -rf temp' } },
        'test-package',
      ),
    ).toThrow(/must also remove "temp"/);
  });

  // Regression fixture for the round-3 #454 review finding
  // (`adaptive-parser-001`): `&&` and `||` have EQUAL precedence and are
  // LEFT-ASSOCIATIVE in real POSIX shell — `/bin/sh -c "true || echo
  // skipped && echo ran"` runs the final command, because `&&` looks back
  // through the skipped `echo skipped` to the STATUS OF THE LAST COMMAND
  // THAT ACTUALLY RAN (`true`, which succeeded), not to the skipped
  // command's own (never-executed) status. So `rm -rf dist || echo
  // recovering && rm -rf temp` DOES reliably remove `temp` on the normal
  // (successful `rm -rf dist`) path: `echo recovering` is skipped, but
  // `rm -rf temp`'s `&&` still sees `rm -rf dist`'s success. An earlier
  // version of this guard AND this very fixture both modeled `&&`/`||` as
  // chaining only the immediately preceding command's reachability, which
  // false-REJECTED this real left-associative shape.
  it('accepts "temp" removed via `rm -rf dist || echo recovering && rm -rf temp` (left-associative &&/|| precedence)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist || echo recovering && rm -rf temp' } },
        'test-package',
      ),
    ).not.toThrow();
  });

  // Regression fixture for the round-3 #454 review finding
  // (`adaptive-parser-001`): the flip side of the left-associative fixture
  // above — treating every command except the literal `false` builtin as
  // successful let a deterministically-failing `exit 1` (which the pre-fix
  // `commandAlwaysFails` didn't recognize) make its `&&`-chained
  // `rm -rf dist temp` look guaranteed, even though `exit 1` prevents it
  // from ever running.
  it('rejects "temp" removed only via `exit 1 && rm -rf dist temp` (adaptive-parser-001: `exit <nonzero>` must be recognized as always-failing)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'exit 1 && rm -rf dist temp' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Regression fixture for the round-3 #454 review finding
  // (`adaptive-parser-002`): a lone `&` (background) was previously
  // recognized only as the LAST character of the whole command string, so
  // a MID-chain `rm -rf dist temp & echo done` was accepted as one
  // ordinary (non-backgrounded) command — but the shell backgrounds
  // `rm -rf dist temp` and moves on to `echo done` immediately, without
  // waiting for the removal to complete.
  it('rejects "temp" removed only via a mid-chain backgrounded `rm -rf dist temp & echo done` (adaptive-parser-002)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist temp & echo done' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Regression fixture for the round-3 #454 review finding
  // (`adaptive-parser-003`): an unquoted `#` starts a comment only when it
  // BEGINS a word, not in the middle of one — `/bin/sh` passes
  // `temp#suffix` as a single literal operand (never as `temp`), so a
  // clean script whose only `temp` mention is glued to a trailing `#...`
  // never actually removes a directory literally named `temp`.
  it('rejects `rm -rf dist temp#suffix` — a mid-word `#` is not a comment (adaptive-parser-003)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist temp#suffix' } },
        'test-package',
      ),
    ).toThrow(/must also remove "temp"/);
  });

  // Regression fixture for the round-3 #454 review finding
  // (`adaptive-parser-004`): quote tracking must be escape-aware. Inside a
  // double-quoted string, `\"` is an ESCAPED quote — it stays part of the
  // string content and does NOT close the quote (only an unescaped `"`
  // does). A quote tracker that closes on any `"` regardless of a
  // preceding backslash would wrongly expose the `rm -rf dist temp`
  // embedded later in this single `echo` argument as a real, executable
  // command — it is never anything but string content.
  it('rejects "rm -rf dist temp" reachable only through an escaped-quote double-quoted string (adaptive-parser-004)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        {
          scripts: {
            clean: 'echo "prefix \\" && rm -rf dist temp"',
          },
        },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Second escape-awareness fixture (adaptive-parser-004): an UNQUOTED
  // backslash-escaped separator (`\;`) is also just an escaped literal
  // character, not a real command separator — `echo prefix\; rm -rf dist
  // temp` is entirely ONE `echo` command (its arguments happen to include
  // the words `rm`, `-rf`, `dist`, `temp`, but they're never invoked as a
  // command).
  it('rejects "rm -rf dist temp" reachable only via an escaped `\\;` separator (adaptive-parser-004)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'echo prefix\\; rm -rf dist temp' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Regression fixture for the round-3 #454 review finding
  // (`adaptive-parser-006`): exact `rm`/`-rf` word matching still accepted
  // a THIRD word that is itself a control/option flag — `rm -rf --help
  // dist temp` satisfies the `rm`/`-rf` prefix exactly, but the real `rm`
  // binary exits after printing help instead of deleting `dist`/`temp`.
  it('rejects `rm -rf --help dist temp` — a control flag turns removal into a no-op (adaptive-parser-006)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf --help dist temp' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Regression fixture for the round-2 #454 review finding: a backslash
  // immediately followed by a newline is a shell line CONTINUATION (the
  // two physical lines are joined into one logical line), so the `||`
  // still gates `rm -rf temp` exactly as it would on a single line — the
  // pre-fix splitter treated the escaped newline as a real separator,
  // discarding the pending `||` and wrongly marking `rm -rf temp`
  // `guaranteed`.
  it('rejects "temp" removed only via `||` across a backslash-newline continuation (guard false-accept #5)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist ||\\\n  rm -rf temp' } },
        'test-package',
      ),
    ).toThrow(/must also remove "temp"/);
  });

  // Regression fixture for the round-2 #454 review finding: everything
  // after an unquoted `#` is a shell comment and never executes, so a
  // required command hidden behind one must not count.
  it('rejects "temp" removed only inside a shell comment (guard false-accept #6)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist # && rm -rf temp' } },
        'test-package',
      ),
    ).toThrow(/must also remove "temp"/);
  });

  // Regression fixture for the round-2 #454 review finding: quoting is
  // shell syntax, not command text — `rm -rf dist temp` inside a
  // single-quoted `echo` argument is a STRING, never actually invoked as a
  // command. A naive delimiter split (ignoring quotes) would also
  // incorrectly split the embedded `;` characters into separate bogus
  // "commands".
  it('rejects "rm -rf dist temp" that only appears as quoted text, never executed (guard false-accept #7)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        {
          scripts: {
            clean: "echo 'prefix; rm -rf dist temp; suffix'",
          },
        },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Regression fixture for the round-2 #454 review finding: `\b`-bounded
  // matching (or naive prefix matching) let `-rf-old` masquerade as `-rf`
  // — but the real `rm` binary rejects `-rf-old` as an unsupported option
  // and removes nothing.
  it('rejects `rm -rf-old dist temp` masquerading as `rm -rf` (guard false-accept #8)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf-old dist temp' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Regression fixture for the round-2 #454 review finding: a backgrounded
  // `rm -rf` (trailing lone `&`, not `&&`) returns immediately without
  // waiting for the removal to complete, so `clean` can return (or a
  // subsequent step can run) before `dist`/`temp` are actually gone.
  it('rejects `rm -rf dist temp &` backgrounded cleanup (guard false-accept #9)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist temp &' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Regression fixture for the round-4 #454 review finding (Copilot +
  // adaptive-parser-001): an `exit` command's STATUS doesn't matter — a
  // reached `exit` (even `exit 0`, which "succeeds") terminates the whole
  // script immediately, so nothing chained after it via `&&` ever runs.
  it('rejects "rm -rf dist temp" reachable only via `exit 0 && rm -rf dist temp` (round-4: exit terminates the script)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'exit 0 && rm -rf dist temp' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Regression fixture for the round-4 #454 review finding: a lone `&`
  // backgrounds the ENTIRE preceding AND/OR list, not just the single
  // command immediately before it — `rm -rf dist temp && echo done &
  // echo next` backgrounds BOTH `rm -rf dist temp` and `echo done` as one
  // asynchronous compound list, so the removal is never guaranteed
  // complete by the time `echo next` (or anything after it) runs.
  it('rejects "rm -rf dist temp" backgrounded via `rm -rf dist temp && echo done & echo next` (round-4: `&` backgrounds the whole AND/OR list)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        {
          scripts: { clean: 'rm -rf dist temp && echo done & echo next' },
        },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Regression fixture for the round-4 #454 review finding: an unescaped
  // `$`/backtick (parameter/command expansion) is out of this lexer's
  // scope and must be rejected fail-closed, not silently lexed as literal
  // text — `rm -rf "$flag" dist temp` could expand `$flag` to `--help` (or
  // anything else) at real shell runtime, hiding a no-op behind a
  // syntactically-valid-looking `rm -rf` invocation.
  it('rejects a clean script containing unescaped `$` expansion (round-4: parameter expansion is out of scope, fails closed)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        {
          scripts: { clean: 'flag=--help; rm -rf "$flag" dist temp' },
        },
        'test-package',
      ),
    ).toThrow(/unsupported shell construct/);
  });

  // Regression fixture for the round-4 #454 review finding: an unterminated
  // quote is a genuine shell syntax error (`/bin/sh` itself rejects it),
  // not text the lexer should silently close on end-of-script.
  it('rejects a clean script with an unterminated quote (round-4: fail closed on unterminated quote)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist temp "' } },
        'test-package',
      ),
    ).toThrow(/unterminated/);
  });

  // Regression fixture for the round-4 #454 review finding: a leading `&&`
  // has no preceding command to gate — `/bin/sh` rejects this as a syntax
  // error rather than treating `rm -rf dist temp` as guaranteed.
  it('rejects a clean script beginning with a dangling `&&` (round-4: fail closed on leading operator)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: '&& rm -rf dist temp' } },
        'test-package',
      ),
    ).toThrow(/dangling "&&"/);
  });

  // Regression fixture for the round-4 #454 review finding: a trailing
  // `&&` has no following command to run — `/bin/sh` rejects this as a
  // syntax error.
  it('rejects a clean script ending with a dangling `&&` (round-4: fail closed on trailing operator)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist temp &&' } },
        'test-package',
      ),
    ).toThrow(/dangling "&&"/);
  });

  // Regression fixture requested by Copilot's round-4 #454 review comment:
  // `exit 0;` (not just `exit 0 &&`) must also be covered — `/bin/sh` exits
  // immediately on a reached `exit`, so nothing after it, chained by ANY
  // operator, ever runs.
  it('rejects "rm -rf dist temp" reachable only via `exit 0; rm -rf dist temp` (exit terminates regardless of the following operator)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'exit 0; rm -rf dist temp' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Regression fixture for the round-5 #454 review finding: an
  // assignment-prefixed `exit` (`X=1 exit 0`) is still the `exit` builtin —
  // POSIX allows any number of leading `NAME=value` words before a special
  // builtin, and the assignment doesn't change its script-terminating
  // effect.
  it('rejects "rm -rf dist temp" reachable only via `X=1 exit 0 && rm -rf dist temp` (assignment-prefixed exit still terminates)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'X=1 exit 0 && rm -rf dist temp' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Regression fixture for the round-5 #454 review finding: `false` is not
  // the only way to invoke a deterministically-failing command — any path
  // form of the real `false` utility (`/bin/false`, `/usr/bin/false`, …)
  // fails identically, so a `&&`-chained required command after it is
  // exactly as unreachable as after the bare `false` builtin.
  it('rejects "rm -rf dist temp" reachable only via `/usr/bin/false && rm -rf dist temp` (path-qualified `false` still always fails)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: '/usr/bin/false && rm -rf dist temp' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Regression fixture for the round-5 #454 review finding: `exit 0 &`
  // backgrounds `exit` into a SUBSHELL — a special builtin running inside a
  // subshell only terminates that subshell, not the main script, so the
  // unconditional `rm -rf dist temp` afterwards still runs and must be
  // accepted (this is the inverse of the other `exit` fixtures: a
  // previously over-strict guard wrongly REJECTED this valid script).
  it('accepts "rm -rf dist temp" reachable via `exit 0 & rm -rf dist temp` (a backgrounded exit only terminates its own subshell)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'exit 0 & rm -rf dist temp' } },
        'test-package',
      ),
    ).not.toThrow();
  });

  // Regression fixture for the round-5 #454 review finding: a leading `;`
  // has no preceding command to separate — `/bin/sh -n` rejects it as a
  // syntax error, but earlier code treated a leading `;` as transparent,
  // identically to a benign leading newline.
  it('rejects a clean script beginning with a dangling `;` (fail closed on a leading separator with no preceding command)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: '; rm -rf dist temp' } },
        'test-package',
      ),
    ).toThrow(/dangling ";"/);
  });

  // Regression fixture for the round-5 #454 review finding: `;` cannot
  // complete a pending `&&`/`||`'s right-hand side the way a newline can —
  // `/bin/sh -n` rejects `true &&; rm -rf dist temp` with a syntax error,
  // but earlier code treated the `;` as benign continuation whitespace.
  it('rejects a clean script with `&&` immediately followed by `;` (fail closed — only a newline may continue a pending `&&`/`||`)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'true &&; rm -rf dist temp' } },
        'test-package',
      ),
    ).toThrow(/"&&" immediately followed by ";"/);
  });

  // Regression fixture for the round-5 #454 review finding: an unquoted
  // `<`/`>` is real I/O redirection, out of this lexer's scope — folding it
  // into ordinary argv would accept `rm -rf dist temp < /nonexistent`, even
  // though `/bin/sh` fails the redirection (no such file) BEFORE `rm` ever
  // runs.
  it("rejects a clean script containing an unquoted redirection operator (fails closed — redirection is out of this lexer's scope)", () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist temp < /nonexistent' } },
        'test-package',
      ),
    ).toThrow(/unsupported shell construct/);
  });

  // Regression fixture for the round-6 #454 review finding: two adjacent
  // `;` separators with no command between them is a `/bin/sh -n` syntax
  // error (outside a `case` clause), but earlier code checked each `;`
  // only against its immediate neighbor and accepted this.
  it('rejects a clean script with two adjacent `;` separators (fail closed — `;;` is invalid outside `case`)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist temp;;' } },
        'test-package',
      ),
    ).toThrow(/multiple statement separators/);
  });

  // Regression fixture for the round-6 #454 review finding: a `;` already
  // terminates the previous statement, so a `&&`/`||` immediately following
  // it has nothing real to its left to chain off of — `/bin/sh -n` rejects
  // this, but earlier code only checked a pending `&&`/`||` followed by
  // `;`, not the reverse ordering.
  it('rejects a clean script with `;` immediately followed by `&&` (fail closed)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist temp; && true' } },
        'test-package',
      ),
    ).toThrow(/not immediately preceded by a command/);
  });

  // Regression fixture for the round-6 #454 review finding: a bare newline
  // that already terminated the previous statement cannot be followed
  // directly by `&&`/`||` either — only a newline appearing AFTER a
  // pending `&&`/`||` (continuing ITS right-hand side, e.g. `dist ||\ntemp`
  // elsewhere in this file) is transparent.
  it('rejects a clean script with a newline immediately followed by `&&` (fail closed)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist temp\n&& true' } },
        'test-package',
      ),
    ).toThrow(/not immediately preceded by a command/);
  });

  // Regression fixture for the round-6 #454 review finding: this lexer's
  // bounded grammar deliberately excludes if/for/while/case/function
  // compound-command syntax (see the module doc's "Scope" paragraph) —
  // treating `if`/`then`/`fi` as ordinary command words instead of
  // rejecting them let a required `rm -rf` that only runs on a conditional
  // branch (here, an always-false `if`) be wrongly counted as
  // unconditionally guaranteed.
  it("rejects a clean script using `if`/`then`/`fi` compound syntax (fails closed — compound commands are out of this lexer's scope)", () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'if false; then\nrm -rf dist temp\nfi' } },
        'test-package',
      ),
    ).toThrow(/reserved word/);
  });

  // Regression fixture for the round-6 #454 review finding: a reached
  // `exec` REPLACES the current shell process with the given command
  // rather than returning to it, so anything chained after it in the
  // original script never runs — `exec /usr/bin/false` deterministically
  // fails and replaces the shell, but earlier code didn't recognize `exec`
  // as script-terminating at all, so the required `rm -rf dist temp` was
  // wrongly counted as reachable.
  it('rejects "rm -rf dist temp" reachable only via `exec /usr/bin/false; rm -rf dist temp` (a reached `exec` terminates the script)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'exec /usr/bin/false; rm -rf dist temp' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Mirrors the round-5 `exit 0 &` fixture above: backgrounding `exec`
  // forks it into a SUBSHELL, so it only replaces THAT subshell, not the
  // main script — the foreground `rm -rf dist temp` still runs
  // unconditionally afterwards.
  it('accepts "rm -rf dist temp" reachable via `exec /usr/bin/false & rm -rf dist temp` (a backgrounded exec only terminates its own subshell)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'exec /usr/bin/false & rm -rf dist temp' } },
        'test-package',
      ),
    ).not.toThrow();
  });

  // Regression fixture for the round-6 #454 review finding: this guard has
  // no basis for assuming an UNRECOGNIZED command's exit status — earlier
  // code optimistically treated every command except a small hardcoded
  // failure set as successful, so a nested shell invocation whose own exit
  // status this bounded lexer can't evaluate (`/bin/sh -c "exit 1"`, which
  // really does fail) let a required `&&`-chained command look guaranteed.
  it('rejects "rm -rf dist temp" reachable only via `/bin/sh -c "exit 1" && rm -rf dist temp` (an unrecognized command\'s status is never assumed successful)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: '/bin/sh -c "exit 1" && rm -rf dist temp' } },
        'test-package',
      ),
    ).toThrow(/must run `rm -rf`/);
  });

  // Regression fixture for the round-6 #454 review finding: an actual
  // carriage return (U+000D) is NOT shell whitespace — `/bin/sh` keeps it
  // as a literal character joined into the surrounding word, but earlier
  // code treated it exactly like a space/tab and split `temp\rjunk` into
  // separate `temp`/`junk` words, letting `temp` be recognized as removed
  // even though the real shell's single `temp\rjunk` operand leaves
  // `temp/` completely untouched.
  it('rejects "temp" removed only when a literal carriage return splits it from trailing text (fail closed — CR is not shell whitespace)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist temp\rjunk' } },
        'test-package',
      ),
    ).toThrow(/must also remove "temp"/);
  });

  // The real proof: every actual, on-disk package discovered by
  // `findApiExtractorPackageDirs` must satisfy the contract. If any future
  // package's `clean` script drifts back to a `dist`-only shape, this
  // fails — closing the exact gap #443 shipped without: nothing else in
  // CI pins this per package.
  it.each(findApiExtractorPackageDirs())(
    'accepts the real, on-disk clean script for %s',
    (packageDir) => {
      const pkg: unknown = JSON.parse(
        readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf8'),
      );
      expect(() =>
        assertPackageCleanRemovesDistAndTemp(
          pkg as Parameters<typeof assertPackageCleanRemovesDistAndTemp>[0],
          packageDir,
        ),
      ).not.toThrow();
    },
  );
});

describe('assertRootCleanRunsWorkspaceCleanAndReset', () => {
  it('rejects a root "clean" script missing `nx run-many --target=clean` entirely', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: { clean: 'NX_TUI=false nx reset' },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  it('rejects a root "clean" script that does not exclude the workspace root project', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(new RegExp(`must exclude\\s+"${WORKSPACE_ROOT_PROJECT_NAME}"`));
  });

  it('rejects excluding a project whose name merely contains the workspace root name as a substring', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace2 && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must exclude/);
  });

  it('rejects `nx run-many --target=clean` that is not itself scoped with NX_TUI=false', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/`nx run-many --target=clean` invocation must itself be scoped/);
  });

  it('rejects a root "clean" script missing `nx reset` entirely', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace',
        },
      }),
    ).toThrow(/must also run `nx reset`/);
  });

  it('rejects `nx reset` running before `nx run-many --target=clean`', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx reset && NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace',
        },
      }),
    ).toThrow(/must run `nx reset` AFTER/);
  });

  // Negative fixture #2: `NX_TUI=false` scoped only to the first command in
  // the chain — a shared prefix that looks identical to a correctly-scoped
  // chain in a shell (both commands still run with the var unset for
  // `nx reset`... no: unset here means the var reverts to whatever the
  // parent shell had, i.e. NOT scoped), but leaves `nx reset` unguarded the
  // moment the chain is reordered or split into separate scripts. This is
  // exactly the mis-scoping issue #443's own fix commit corrected.
  it('rejects NX_TUI=false scoped only to the first command, leaving `nx reset` unscoped', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && nx reset',
        },
      }),
    ).toThrow(/`nx reset` invocation must itself be scoped/);
  });

  it('accepts a correctly-shaped root "clean" script (positive control)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).not.toThrow();
  });

  // Regression fixture for the post-#454 review finding: `findFlagValue`
  // (pre-fix) matched only the FIRST `--flag=value` token with exact
  // equality, so a valid `nx run-many` invocation carrying a REPEATED
  // `--exclude` flag (e.g. `--exclude=website --exclude=agentmonitors-workspace`,
  // a legitimate shape `nx` itself supports for excluding multiple
  // projects) false-REJECTED, because only the first occurrence
  // (`website`) was ever inspected and the workspace-root project name was
  // never checked.
  it('accepts a root "clean" script with the workspace root excluded via a repeated `--exclude` flag', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=website --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).not.toThrow();
  });

  // Regression fixture for the post-#454 review finding: the pre-fix
  // `\b`-bounded-regex replacement compared `--target=`'s raw value with
  // exact string equality, so a valid comma-joined `nx` target list
  // (`--target=clean,other`, which legitimately also runs the `clean`
  // target) false-REJECTED because the raw value `"clean,other"` never
  // equals `"clean"`.
  it('accepts a root "clean" script with a comma-joined `--target=clean,other`', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean,other --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).not.toThrow();
  });

  // Regression fixtures for the post-#443 review finding: `||` means "only
  // run if the previous command FAILED", so `nx reset` reachable only via
  // `run-many || nx reset` does NOT reliably reset the cache — a
  // successful `run-many` (the normal case) skips it entirely. The pre-fix
  // guard flattened `&&` and `||` identically and wrongly accepted both of
  // these shapes.
  it('rejects `nx run-many` reachable only via `||` (guard false-accept #1a)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'echo noop || NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  it('rejects `nx reset` reachable only via `||` (guard false-accept #1b)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace || NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must also run `nx reset`/);
  });

  // Regression fixtures for the post-#443 review finding: `\b`-bounded
  // regexes match a word boundary right before a hyphen, so
  // `--target=clean-old`, `--exclude=agentmonitors-workspace-old`, and
  // `nx reset-old` were all wrongly accepted as the exact required tokens.
  it('rejects `--target=clean-old` masquerading as `--target=clean` (guard false-accept #2a)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean-old --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  it('rejects `--exclude=agentmonitors-workspace-old` masquerading as excluding the workspace root (guard false-accept #2b)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace-old && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(new RegExp(`must exclude\\s+"${WORKSPACE_ROOT_PROJECT_NAME}"`));
  });

  it('rejects `nx reset-old` masquerading as `nx reset` (guard false-accept #2c)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset-old',
        },
      }),
    ).toThrow(/must also run `nx reset`/);
  });

  // Regression fixture for the round-2 #454 review finding: `false`
  // deterministically fails, so NEITHER `&&`-chained command after it ever
  // runs — a splitter that optimistically assumes every unrecognized
  // command succeeds (correct for `rm -rf`/real `nx` invocations) must
  // still special-case the literal `false` builtin, or this adversarial
  // shape looks identical to a real `guaranteed: true` chain.
  it('rejects `false && run-many && reset` (guard false-accept #10: `&&` after a deterministically-failing command)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'false && NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-2 #454 review finding: a backslash
  // immediately followed by a newline is a shell line CONTINUATION, so
  // `run-many ||\` + newline + `reset` still gates `nx reset` on run-many
  // FAILING, exactly as `run-many || reset` on one line would.
  it('rejects `nx reset` reachable only via `||` across a backslash-newline continuation (guard false-accept #11)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace ||\\\n NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must also run `nx reset`/);
  });

  // Regression fixture for the round-2 #454 review finding: everything
  // after an unquoted `#` is a shell comment and never executes.
  it('rejects `nx reset` hidden behind a shell comment (guard false-accept #12)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace # && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must also run `nx reset`/);
  });

  // Regression fixture for the round-2 #454 review finding: quoted text is
  // not executed shell syntax — both required invocations here are only
  // ever a single-quoted `echo` argument.
  it('rejects both required invocations that only appear as quoted text, never executed (guard false-accept #13)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            "echo 'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset'",
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-2 #454 review finding: the real `nx`
  // CLI exits 0 after printing help for `--help`/`--dry-run`, without
  // running the target or performing a reset — a control flag turns both
  // required invocations into successful no-ops.
  it('rejects `nx run-many ... --help && nx reset --help` no-op invocations (guard false-accept #14)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace --help && NX_TUI=false nx reset --help',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-3 #454 review finding
  // (`adaptive-parser-001`): left-associative equal-precedence `&&`/`||` —
  // see the package-level fixture above for the full explanation. Skipping
  // `echo recovering` must NOT stop `nx reset`'s `&&` from seeing
  // `run-many`'s own (successful) status.
  it('accepts `run-many || echo recovering && reset` (left-associative &&/|| precedence)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace || echo recovering && NX_TUI=false nx reset',
        },
      }),
    ).not.toThrow();
  });

  it('rejects `exit 1 && run-many && reset` (adaptive-parser-001: `exit <nonzero>` must be recognized as always-failing)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'exit 1 && NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-3 #454 review finding
  // (`adaptive-parser-002`): a lone `&` is a control operator wherever it
  // appears, not just as the final character — `run-many & echo done`
  // backgrounds `run-many` and moves straight on to `echo done`, so the
  // fan-out clean is never guaranteed to have finished (`nx reset` on the
  // next line still runs, but that alone isn't the required contract).
  it('rejects a mid-chain backgrounded `run-many & echo done` (adaptive-parser-002)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace & echo done\nNX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-3 #454 review finding
  // (`adaptive-parser-003`): an unquoted `#` starts a comment only at the
  // start of a word — a `#` glued onto the end of `--exclude=`'s value is
  // just more of that value, not a comment marker, so the exclusion never
  // actually matches the workspace root project name.
  it('rejects `--exclude=agentmonitors-workspace#suffix` — a mid-word `#` is not a comment (adaptive-parser-003)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace#suffix\nNX_TUI=false nx reset',
        },
      }),
    ).toThrow(new RegExp(`must exclude\\s+"${WORKSPACE_ROOT_PROJECT_NAME}"`));
  });

  // Regression fixture for the round-3 #454 review finding
  // (`adaptive-parser-004`): escape-aware quote tracking — an escaped `\"`
  // inside a double-quoted string keeps it open, so both required
  // invocations here are still only ever inside a single `echo` argument,
  // never executed.
  it('rejects both required invocations reachable only through an escaped-quote double-quoted string (adaptive-parser-004)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'echo "prefix \\" NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset"',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-3 #454 review finding
  // (`adaptive-parser-005`): the no-op-flag check must compare against
  // quote-REMOVED words — a quoted `"--help"` passes the exact same argv
  // token to `nx` as an unquoted `--help` would, so it must be caught the
  // same way.
  it('rejects `nx run-many ... "--help" && nx reset "--help"` — quoted no-op flags (adaptive-parser-005)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace "--help" && NX_TUI=false nx reset "--help"',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-4 #454 review finding (Copilot +
  // adaptive-parser-001): `exit 0` "succeeds", but a REACHED `exit`
  // terminates the whole script — nothing chained after it via `&&` ever
  // runs, so `run-many`/`reset` here are unreachable syntax garbage, not a
  // real guaranteed chain.
  it('rejects `exit 0 && run-many && reset` (round-4: exit terminates the script even on a "successful" status)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'exit 0 && NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-4 #454 review finding: a lone `&`
  // backgrounds the ENTIRE preceding AND/OR list — `run-many && echo done &
  // reset` backgrounds BOTH `run-many` and `echo done` as one asynchronous
  // list, so the fan-out clean is never guaranteed complete by the time
  // `reset` (freshly reachable after the `&`) runs.
  it('rejects `run-many && echo done & reset` (round-4: `&` backgrounds the whole preceding AND/OR list)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && echo done & NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-4 #454 review finding: unescaped `$`
  // expansion must fail closed rather than being lexed as literal text.
  it('rejects a root clean script containing unescaped `$` expansion (round-4: parameter expansion is out of scope, fails closed)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'flag=--help; NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace "$flag" && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/unsupported shell construct/);
  });

  // Regression fixture for the round-4 #454 review finding: an
  // unterminated quote is a genuine shell syntax error.
  it('rejects a root clean script with an unterminated quote (round-4: fail closed on unterminated quote)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset "',
        },
      }),
    ).toThrow(/unterminated/);
  });

  // Regression fixture for the round-4 #454 review finding: a leading `&&`
  // has no preceding command to gate.
  it('rejects a root clean script beginning with a dangling `&&` (round-4: fail closed on leading operator)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            '&& NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/dangling "&&"/);
  });

  // Regression fixture for the round-4 #454 review finding: a trailing
  // `&&` has no following command to run.
  it('rejects a root clean script ending with a dangling `&&` (round-4: fail closed on trailing operator)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset &&',
        },
      }),
    ).toThrow(/dangling "&&"/);
  });

  // Regression fixture requested by Copilot's round-4 #454 review comment:
  // `exit 0;` (not just `exit 0 &&`) must also be covered.
  it('rejects `exit 0; run-many; reset` (exit terminates regardless of the following operator)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'exit 0; NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace; NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-5 #454 review finding: an
  // assignment-prefixed `exit` (`X=1 exit 0`) is still the `exit` builtin
  // and still terminates the script.
  it('rejects `X=1 exit 0 && run-many && reset` (assignment-prefixed exit still terminates)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'X=1 exit 0 && NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-5 #454 review finding: any path form
  // of the real `false` utility (not just the bare `false` word) fails
  // identically, so it must gate a following `&&` exactly like `false`
  // does.
  it('rejects `/usr/bin/false && run-many && reset` (path-qualified `false` still always fails)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            '/usr/bin/false && NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-5 #454 review finding: `exit 0 &`
  // backgrounds `exit` into a subshell, so the unconditional `run-many`/
  // `reset` afterwards still runs and must be ACCEPTED — the inverse of
  // the other `exit` fixtures (a previously over-strict guard wrongly
  // rejected this valid script).
  it('accepts `exit 0 & run-many && reset` (a backgrounded exit only terminates its own subshell)', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'exit 0 & NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).not.toThrow();
  });

  // Regression fixture for the round-5 #454 review finding: a leading `;`
  // has no preceding command to separate and is invalid syntax.
  it('rejects a root clean script beginning with a dangling `;`', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            '; NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/dangling ";"/);
  });

  // Regression fixture for the round-5 #454 review finding: only a newline
  // may continue a pending `&&`/`||` — a `;` immediately after cannot.
  it('rejects a root clean script with `&&` immediately followed by `;`', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'true &&; NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/"&&" immediately followed by ";"/);
  });

  // Regression fixture for the round-5 #454 review finding: an unquoted
  // `<`/`>` is real I/O redirection, out of this lexer's scope — folding
  // it into ordinary argv would let a failed redirection's target words
  // masquerade as real required-command argv.
  it('rejects a root clean script containing an unquoted redirection operator', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace < /nonexistent && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/unsupported shell construct/);
  });

  // Regression fixture for the round-6 #454 review finding: two adjacent
  // `;` separators with no command between them, mirroring the package
  // fixture above.
  it('rejects a root clean script with two adjacent `;` separators', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace;; NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/multiple statement separators/);
  });

  // Regression fixture for the round-6 #454 review finding: a `;` already
  // terminates the previous statement, so an immediately-following `&&`
  // has nothing real to its left, mirroring the package fixture above.
  it('rejects a root clean script with `;` immediately followed by `&&`', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace; && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/not immediately preceded by a command/);
  });

  // Regression fixture for the round-6 #454 review finding: a bare newline
  // that already terminated the previous statement cannot be followed
  // directly by `&&` either, mirroring the package fixture above.
  it('rejects a root clean script with a newline immediately followed by `&&`', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace\n&& NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/not immediately preceded by a command/);
  });

  // Regression fixture for the round-6 #454 review finding: a reached
  // `exec` terminates the whole script, mirroring the package fixture
  // above — `exec /usr/bin/false` replaces the shell before either
  // required Nx invocation ever runs.
  it('rejects a root clean script reachable only via `exec /usr/bin/false; <run-many> && <reset>`', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'exec /usr/bin/false; NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-6 #454 review finding: an
  // unrecognized command's exit status is never assumed successful,
  // mirroring the package fixture above.
  it('rejects a root clean script reachable only via `/bin/sh -c "exit 1" && <run-many> && <reset>`', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            '/bin/sh -c "exit 1" && NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must invoke `nx run-many --target=clean`/);
  });

  // Regression fixture for the round-6 #454 review finding: an actual
  // carriage return is not shell whitespace, mirroring the package fixture
  // above — it stays part of the `--exclude=` flag's value, so the
  // required workspace-root project name is never matched exactly.
  it('rejects a root clean script whose `--exclude=` value is split from the workspace project name only by a literal carriage return', () => {
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset({
        scripts: {
          clean:
            'NX_TUI=false nx run-many --target=clean --exclude=agentmonitors-workspace\rsuffix && NX_TUI=false nx reset',
        },
      }),
    ).toThrow(/must exclude/);
  });

  // The real proof: the actual, on-disk root package.json.
  it('accepts the real, on-disk root package.json', () => {
    const pkg: unknown = JSON.parse(
      readFileSync(ROOT_PACKAGE_JSON_PATH, 'utf8'),
    );
    expect(() =>
      assertRootCleanRunsWorkspaceCleanAndReset(
        pkg as Parameters<typeof assertRootCleanRunsWorkspaceCleanAndReset>[0],
      ),
    ).not.toThrow();
  });
});
