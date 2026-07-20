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

  // Regression fixture for the round-2 #454 review finding: a command
  // reachable only via an unresolved `||` branch was still marked
  // `guaranteed: true` once re-joined by a subsequent `&&` — `cmd2` here
  // only runs if `rm -rf dist` FAILED, so `rm -rf temp` (joined to `cmd2`
  // by `&&`) is only reachable on that same failure path, not the normal
  // success path.
  it('rejects "temp" removed only via `cmd1 || cmd2 && rm -rf temp` (guard false-accept #4: unresolved `||` reachability not propagated through `&&`)', () => {
    expect(() =>
      assertPackageCleanRemovesDistAndTemp(
        { scripts: { clean: 'rm -rf dist || echo recovering && rm -rf temp' } },
        'test-package',
      ),
    ).toThrow(/must also remove "temp"/);
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
