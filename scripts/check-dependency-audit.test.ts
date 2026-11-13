/**
 * Tests for the production-dependency audit gate (Refs #290).
 *
 * `evaluateAuditReport`/`loadAllowlist` are exercised against fixture data
 * shaped exactly like the real `pnpm audit --prod --audit-level high --json`
 * report (captured from a real run against this repo — see the advisory
 * shape below) and the real shipped `scripts/audit-allowlist.json`, so the
 * parsing logic is proven against the actual contract, not a hand-built
 * approximation.
 *
 * The "resolved dependency versions" suite at the bottom is the lockfile
 * regression check from the issue's definition of done: it shells out to the
 * real `pnpm why --json` (the actual resolution pnpm computed from
 * `pnpm-lock.yaml`) and asserts every previously-vulnerable package now
 * resolves to a patched version everywhere in the workspace.
 *
 * @see https://pnpm.io/cli/audit
 * @see https://pnpm.io/cli/why
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { PACKAGE_DIRS } from './publish-release-packages.mjs';
import {
  DEFAULT_ALLOWLIST_PATH,
  assertValidAuditReport,
  bundledAuditReport,
  evaluateAuditReport,
  loadAllowlist,
  resolvedVersions,
  resolvedVersionsUnderAncestor,
  versionAtLeast,
} from './check-dependency-audit.mjs';

// Shape matches a real `pnpm audit --prod --audit-level high --json` advisory
// record (see scripts/check-dependency-audit.mjs's Advisory typedef).
function advisory(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    github_advisory_id: 'GHSA-aaaa-bbbb-cccc',
    module_name: 'example-pkg',
    severity: 'high',
    title: 'Example advisory',
    url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    ...overrides,
  };
}

describe('evaluateAuditReport', () => {
  it('reports every high/critical advisory as blocking when there are no exceptions', () => {
    const report = {
      advisories: {
        1: advisory({ severity: 'high' }),
        2: advisory({
          github_advisory_id: 'GHSA-dddd-eeee-ffff',
          severity: 'critical',
        }),
      },
    };

    const { blocking, suppressed, expiredExceptions } = evaluateAuditReport(
      report,
      [],
    );

    expect(blocking).toHaveLength(2);
    expect(suppressed).toHaveLength(0);
    expect(expiredExceptions).toHaveLength(0);
  });

  it('ignores advisories below high severity', () => {
    const report = {
      advisories: {
        1: advisory({ severity: 'moderate' }),
        2: advisory({ severity: 'low' }),
      },
    };

    const { blocking } = evaluateAuditReport(report, []);

    expect(blocking).toHaveLength(0);
  });

  it('suppresses a high advisory covered by a non-expired exception', () => {
    const report = {
      advisories: {
        1: advisory({ github_advisory_id: 'GHSA-aaaa-bbbb-cccc' }),
      },
    };
    const exceptions = [
      {
        id: 'GHSA-aaaa-bbbb-cccc',
        package: 'example-pkg',
        reason: 'no fix available yet',
        expires: '2099-01-01',
      },
    ];

    const { blocking, suppressed } = evaluateAuditReport(report, exceptions, {
      now: new Date('2026-07-14'),
    });

    expect(blocking).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.advisory.github_advisory_id).toBe(
      'GHSA-aaaa-bbbb-cccc',
    );
  });

  // Guards against a copy-paste allowlist error: an entry whose `id` matches
  // but whose `package` doesn't must not suppress — otherwise a mistyped or
  // reused exception could silently cover an unrelated advisory.
  it('does not suppress when the exception package does not match the advisory module', () => {
    const report = {
      advisories: {
        1: advisory({
          github_advisory_id: 'GHSA-aaaa-bbbb-cccc',
          module_name: 'example-pkg',
        }),
      },
    };
    const exceptions = [
      {
        id: 'GHSA-aaaa-bbbb-cccc',
        package: 'some-other-pkg',
        reason: 'copy-pasted from a different exception',
        expires: '2099-01-01',
      },
    ];

    const { blocking, suppressed } = evaluateAuditReport(report, exceptions, {
      now: new Date('2026-07-14'),
    });

    expect(blocking).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
  });

  // Regression: before expiry enforcement existed, an exception could be
  // added once and silently suppress its advisory forever. This proves an
  // expired exception no longer excuses the advisory — the gate goes back to
  // failing until the exception is renewed or removed.
  it('treats an expired exception as no longer suppressing its advisory', () => {
    const report = {
      advisories: {
        1: advisory({ github_advisory_id: 'GHSA-aaaa-bbbb-cccc' }),
      },
    };
    const exceptions = [
      {
        id: 'GHSA-aaaa-bbbb-cccc',
        package: 'example-pkg',
        reason: 'no fix available yet',
        expires: '2020-01-01',
      },
    ];

    const { blocking, suppressed, expiredExceptions } = evaluateAuditReport(
      report,
      exceptions,
      {
        now: new Date('2026-07-14'),
      },
    );

    expect(blocking).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
    expect(expiredExceptions).toHaveLength(1);
  });

  // Regression: a date-only `expires` (YYYY-MM-DD) must remain valid through
  // the *entire* expires day (UTC) — not expire at its start. Before this
  // fix, an exception dated "2026-07-14" would already read as expired at
  // any time later that same day.
  it('remains valid through the entire expires day (UTC), not just its start', () => {
    const report = {
      advisories: {
        1: advisory({ github_advisory_id: 'GHSA-aaaa-bbbb-cccc' }),
      },
    };
    const exceptions = [
      {
        id: 'GHSA-aaaa-bbbb-cccc',
        package: 'example-pkg',
        reason: 'no fix available yet',
        expires: '2026-07-14',
      },
    ];

    const { blocking, suppressed, expiredExceptions } = evaluateAuditReport(
      report,
      exceptions,
      { now: new Date('2026-07-14T23:59:59.999Z') },
    );

    expect(blocking).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
    expect(expiredExceptions).toHaveLength(0);
  });

  it('expires at the start of the day after the expires date', () => {
    const report = {
      advisories: {
        1: advisory({ github_advisory_id: 'GHSA-aaaa-bbbb-cccc' }),
      },
    };
    const exceptions = [
      {
        id: 'GHSA-aaaa-bbbb-cccc',
        package: 'example-pkg',
        reason: 'no fix available yet',
        expires: '2026-07-14',
      },
    ];

    const { blocking, suppressed, expiredExceptions } = evaluateAuditReport(
      report,
      exceptions,
      { now: new Date('2026-07-15T00:00:00.000Z') },
    );

    expect(blocking).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
    expect(expiredExceptions).toHaveLength(1);
  });

  // Sustainability: an exception whose advisory has already been fixed
  // elsewhere (so it no longer appears in the report) still has to be
  // cleaned up once it expires — expiry is checked independent of whether
  // the advisory is currently present, so stale entries can't linger unseen.
  it('flags an expired exception even when its advisory no longer appears in the report', () => {
    const report = { advisories: {} };
    const exceptions = [
      {
        id: 'GHSA-aaaa-bbbb-cccc',
        package: 'example-pkg',
        reason: 'fixed upstream, entry not yet removed',
        expires: '2020-01-01',
      },
    ];

    const { blocking, expiredExceptions } = evaluateAuditReport(
      report,
      exceptions,
      {
        now: new Date('2026-07-14'),
      },
    );

    expect(blocking).toHaveLength(0);
    expect(expiredExceptions).toHaveLength(1);
  });

  it('does not flag a non-expired exception whose advisory is absent as expired or blocking', () => {
    const report = { advisories: {} };
    const exceptions = [
      {
        id: 'GHSA-aaaa-bbbb-cccc',
        package: 'example-pkg',
        reason: 'preemptive exception',
        expires: '2099-01-01',
      },
    ];

    const { blocking, expiredExceptions } = evaluateAuditReport(
      report,
      exceptions,
      {
        now: new Date('2026-07-14'),
      },
    );

    expect(blocking).toHaveLength(0);
    expect(expiredExceptions).toHaveLength(0);
  });

  // Defense in depth for the permanent-bypass regression above: even if an
  // invalid `expires` reaches `evaluateAuditReport` directly (bypassing
  // `loadAllowlist`'s validation, as this test does), an unparseable expiry
  // must fail *closed* (treated as already expired) rather than *open*
  // (treated as never expiring).
  it('treats an exception with an unparseable expires as already expired (fail closed)', () => {
    const report = {
      advisories: {
        1: advisory({ github_advisory_id: 'GHSA-aaaa-bbbb-cccc' }),
      },
    };
    const exceptions = [
      {
        id: 'GHSA-aaaa-bbbb-cccc',
        package: 'example-pkg',
        reason: 'bypassed validation',
        expires: '2026-13-01',
      },
    ];

    const { blocking, suppressed, expiredExceptions } = evaluateAuditReport(
      report,
      exceptions,
      { now: new Date('2026-07-14') },
    );

    expect(blocking).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
    expect(expiredExceptions).toHaveLength(1);
  });
});

// Regression: `pnpm audit --json` reports a *tooling* failure (registry
// unreachable, etc.) as `{"error": {...}}` on stdout, with no "advisories"
// key. Before this check, `evaluateAuditReport`'s `Object.values(report
// .advisories ?? {})` treated that shape as "zero advisories" — a false
// "clean" result for a security gate. Reproduced live via
// `pnpm audit --prod --audit-level high --json --registry=http://invalid.invalid.invalid/`.
describe('assertValidAuditReport', () => {
  it('accepts a well-formed report with an advisories object', () => {
    const report = { advisories: {} };

    expect(assertValidAuditReport(report)).toEqual(report);
  });

  it('throws on a real `pnpm audit` tooling-failure shape (registry unreachable)', () => {
    const toolingFailure = { error: { code: 'pnpm', message: 'fetch failed' } };

    expect(() => assertValidAuditReport(toolingFailure)).toThrow(
      /audit tooling failed, not a clean result.*fetch failed/,
    );
  });

  it('throws when the report has no "advisories" object at all', () => {
    expect(() => assertValidAuditReport({ metadata: {} })).toThrow(
      /audit tooling failed, not a clean result/,
    );
  });

  it('throws on a non-object report', () => {
    expect(() => assertValidAuditReport(null)).toThrow(
      /audit tooling failed, not a clean result/,
    );
    expect(() => assertValidAuditReport('clean')).toThrow(
      /audit tooling failed, not a clean result/,
    );
  });
});

describe('loadAllowlist', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a well-formed allowlist file', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'audit-allowlist-'));
    const file = path.join(tmpDir, 'allowlist.json');
    writeFileSync(
      file,
      JSON.stringify({
        exceptions: [
          {
            id: 'GHSA-aaaa-bbbb-cccc',
            package: 'example-pkg',
            reason: 'reason',
            expires: '2099-01-01',
          },
        ],
      }),
    );

    expect(loadAllowlist(file)).toHaveLength(1);
  });

  it('loads an empty exceptions list', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'audit-allowlist-'));
    const file = path.join(tmpDir, 'allowlist.json');
    writeFileSync(file, JSON.stringify({ exceptions: [] }));

    expect(loadAllowlist(file)).toEqual([]);
  });

  it('throws when the file has no "exceptions" array', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'audit-allowlist-'));
    const file = path.join(tmpDir, 'allowlist.json');
    writeFileSync(file, JSON.stringify({ foo: 'bar' }));

    expect(() => loadAllowlist(file)).toThrow(/"exceptions" array/);
  });

  it('throws when an entry is missing a required field', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'audit-allowlist-'));
    const file = path.join(tmpDir, 'allowlist.json');
    writeFileSync(
      file,
      JSON.stringify({
        exceptions: [{ id: 'GHSA-aaaa-bbbb-cccc' /* missing expires */ }],
      }),
    );

    expect(() => loadAllowlist(file)).toThrow(/expires/);
  });

  // Regression: validation previously only enforced "id" and "expires", so an
  // entry with no "package"/"reason" loaded successfully and `main()` printed
  // `undefined` for them — a malformed entry now fails loudly at load time.
  it('throws when an entry is missing "package"', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'audit-allowlist-'));
    const file = path.join(tmpDir, 'allowlist.json');
    writeFileSync(
      file,
      JSON.stringify({
        exceptions: [
          {
            id: 'GHSA-aaaa-bbbb-cccc',
            reason: 'no fix available yet',
            expires: '2099-01-01',
            /* missing package */
          },
        ],
      }),
    );

    expect(() => loadAllowlist(file)).toThrow(/"package"/);
  });

  it('throws when an entry is missing "reason"', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'audit-allowlist-'));
    const file = path.join(tmpDir, 'allowlist.json');
    writeFileSync(
      file,
      JSON.stringify({
        exceptions: [
          {
            id: 'GHSA-aaaa-bbbb-cccc',
            package: 'example-pkg',
            expires: '2099-01-01',
            /* missing reason */
          },
        ],
      }),
    );

    expect(() => loadAllowlist(file)).toThrow(/"reason"/);
  });

  it('throws when "expires" is not in YYYY-MM-DD format', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'audit-allowlist-'));
    const file = path.join(tmpDir, 'allowlist.json');
    writeFileSync(
      file,
      JSON.stringify({
        exceptions: [
          {
            id: 'GHSA-aaaa-bbbb-cccc',
            package: 'example-pkg',
            reason: 'no fix available yet',
            expires: '01/01/2099',
          },
        ],
      }),
    );

    expect(() => loadAllowlist(file)).toThrow(/YYYY-MM-DD/);
  });

  // Regression: "2026-13-01" (month 13) matches the YYYY-MM-DD *format*
  // regex but parses to `Invalid Date`. Since `NaN` compares `false` against
  // everything, evaluateAuditReport's old `now.getTime() >= new
  // Date(exception.expires).getTime()` would never be true — the exception
  // would never expire, a permanent bypass. Must be rejected at load time.
  it('throws when "expires" has an out-of-range month (permanent-bypass regression)', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'audit-allowlist-'));
    const file = path.join(tmpDir, 'allowlist.json');
    writeFileSync(
      file,
      JSON.stringify({
        exceptions: [
          {
            id: 'GHSA-aaaa-bbbb-cccc',
            package: 'example-pkg',
            reason: 'no fix available yet',
            expires: '2026-13-01',
          },
        ],
      }),
    );

    expect(() => loadAllowlist(file)).toThrow(/valid calendar date/);
  });

  // Regression: "2026-02-30" also matches the format regex, but
  // `new Date(...)` silently rolls it over to March 2nd instead of raising —
  // moving the real expiry later than what was written. Caught by
  // round-tripping through `toISOString` and comparing back to the input.
  it('throws when "expires" is a rolled-over calendar date (e.g. Feb 30)', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'audit-allowlist-'));
    const file = path.join(tmpDir, 'allowlist.json');
    writeFileSync(
      file,
      JSON.stringify({
        exceptions: [
          {
            id: 'GHSA-aaaa-bbbb-cccc',
            package: 'example-pkg',
            reason: 'no fix available yet',
            expires: '2026-02-30',
          },
        ],
      }),
    );

    expect(() => loadAllowlist(file)).toThrow(/valid calendar date/);
  });

  it('loads the real shipped scripts/audit-allowlist.json without throwing', () => {
    expect(() => loadAllowlist(DEFAULT_ALLOWLIST_PATH)).not.toThrow();
  });
});

describe('versionAtLeast', () => {
  it('returns true for an exact match', () => {
    expect(versionAtLeast('4.17.24', '4.17.24')).toBe(true);
  });

  it('returns true when the actual version is newer', () => {
    expect(versionAtLeast('4.18.1', '4.17.24')).toBe(true);
    expect(versionAtLeast('16.2.10', '16.2.6')).toBe(true);
  });

  it('returns false when the actual version is older', () => {
    expect(versionAtLeast('4.17.23', '4.17.24')).toBe(false);
    expect(versionAtLeast('0.45.1', '0.45.2')).toBe(false);
  });

  it('treats a missing trailing component as zero', () => {
    expect(versionAtLeast('1.2', '1.2.0')).toBe(true);
    expect(versionAtLeast('1.2', '1.2.1')).toBe(false);
  });
});

// Lockfile regression check (issue #290 DoD: "Include a lockfile regression
// check proving the patched versions are actually selected"). Each entry
// is a package this issue fixed and the minimum patched version from its
// GitHub advisory. Runs the real `pnpm why --json` against the workspace's
// actual node_modules/lockfile resolution.
const PATCHED_MINIMUMS = [
  // GHSA-mrhx-c7xc-m3w5: direct validation must resolve patched Zod 4.
  { package: 'zod', minVersion: '4.6.6' },
  // Published dependency floors must cover the advisory fixes even outside
  // this workspace, where pnpm overrides do not accompany our packages.
  // GHSA-p95v-992w-h6c3 (TOON); GHSA-46jr-4wx8-v453 and related SDK advisories.
  { package: '@toon-format/toon', minVersion: '2.3.1' },
  { package: '@modelcontextprotocol/sdk', minVersion: '1.32.0' },
  // drizzle-orm: GHSA (libs/core) — patched >=0.45.2
  { package: 'drizzle-orm', minVersion: '0.45.2' },
  // lodash-es via cel-js>chevrotain (libs/core) — GHSA-r5fr-rjxr-66jc, patched >=4.18.0
  { package: 'lodash-es', minVersion: '4.18.0' },
  // fast-uri via @modelcontextprotocol/sdk>ajv (apps/cli) — GHSA-v39h-62p7-jpjc,
  // GHSA-w74x-v6f9-j3xg and authority normalization fixes, patched >=3.1.9
  { package: 'fast-uri', minVersion: '3.1.9' },
  // hono via MCP — GHSA-5r4p-p66f-jhc7, patched >=4.13.11
  { package: 'hono', minVersion: '4.13.11' },
  // @hono/node-server via @modelcontextprotocol/sdk (apps/cli) — moderate
  // GHSA-frvp-7c67-39w9 (patched >=1.19.15) and GHSA-rmxm-3fg6-px4f
  // (patched >=2.1.3). The SDK's declared range `^1.19.9 || ^2.0.5`
  // already admits the patched 2.x line, so external installs get it too.
  { package: '@hono/node-server', minVersion: '2.1.3' },
  // next — GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r,
  // GHSA-673q-mjm6-r5xr, patched >=16.4.1
  { package: 'next', minVersion: '16.4.1' },
  // ip-address via @modelcontextprotocol/sdk>express-rate-limit (apps/cli) —
  // GHSA-rxp7-6hxx-x8q5, patched >=10.7.4
  { package: 'ip-address', minVersion: '10.7.4' },
  // sharp, an optional dependency of next — GHSA-wq5f-xc86-pv6w,
  // patched >=0.35.5
  { package: 'sharp', minVersion: '0.35.5' },
];

describe('resolved dependency versions clear known advisories (lockfile regression)', () => {
  for (const { package: pkg, minVersion } of PATCHED_MINIMUMS) {
    it(`${pkg} resolves to >= ${minVersion} everywhere in the workspace lockfile`, () => {
      const versions = resolvedVersions(pkg);

      expect(versions.length).toBeGreaterThan(0);
      for (const version of versions) {
        expect(
          versionAtLeast(version, minVersion),
          `expected ${pkg}@${version} to be >= ${minVersion}`,
        ).toBe(true);
      }
    });
  }
});

// Some packages this issue fixed legitimately resolve to more than one line
// in the workspace lockfile — a devDependency-only build tool pinned to an
// old, unpatched line (out of `pnpm audit --prod`'s scope) alongside the
// production path the override/upgrade actually targets. A blanket "every
// resolved version is >= N" check (as above) would fail on the untouched
// line, so these assert only against the specific path named in the
// advisory's `paths` (via `resolvedVersionsUnderAncestor`'s ancestor-scoped
// search of the `pnpm why --json` tree).
const PATCHED_MINIMUMS_UNDER_ANCESTOR = [
  // Production glob cancellation and minimatch globparts amplification fixes
  // must reach every direct consumer, including published unbundled paths.
  // GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249.
  ...[
    '@agentmonitors/core',
    '@agentmonitors/cli',
    '@agentmonitors/source-file-fingerprint',
  ].flatMap((ancestor) => [
    { package: 'glob', ancestor, minVersion: '14.0.2' },
    { package: 'minimatch', ancestor, minVersion: '11.0.1' },
  ]),
  // GHSA-68fv-2mgg-jv7q, GHSA-jqcg-44mw-7w3h, GHSA-27r3-jxmh-p828:
  // check the affected production paths independently of development tools.
  { package: 'source-map-js', ancestor: 'next', minVersion: '1.2.2' },
  {
    package: 'proxy-addr',
    ancestor: '@modelcontextprotocol/sdk',
    minVersion: '2.0.8',
  },
  {
    package: 'body-parser',
    ancestor: '@modelcontextprotocol/sdk',
    minVersion: '2.4.0',
  },
  // gray-matter (libs/core, a direct dependency) pins the js-yaml 3.x line —
  // GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, patched >=3.15.1. The other
  // resolved js-yaml@3.x instances (nx>@yarnpkg/parsers, nx>front-matter,
  // @changesets/cli's transitive read-yaml-file@1) are devDependency-only
  // tooling, out of `--prod` audit scope, and intentionally left alone.
  { package: 'js-yaml', ancestor: 'gray-matter', minVersion: '3.15.1' },
  // @markdoc/next.js (apps/website, a direct dependency) pins the js-yaml
  // 4.x line — same two advisories, patched >=4.3.1.
  { package: 'js-yaml', ancestor: '@markdoc/next.js', minVersion: '4.3.1' },
  // Our own `glob` dependency (libs/core, apps/cli,
  // plugins/source-file-fingerprint) resolves minimatch, which pulls
  // brace-expansion — GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg,
  // GHSA-rgw5-rvv9-x895 and later fixes, enforced floor >=5.0.12. Scoped to the `@agentmonitors/core`
  // ancestor (rather than `glob` or `minimatch`, whose names are also used,
  // at different unrelated majors, by devDependency-only tooling such as
  // fixturify-project and nx) to isolate this exact path.
  {
    package: 'brace-expansion',
    ancestor: '@agentmonitors/core',
    minVersion: '5.0.12',
  },
  // postcss, a dependency of next (apps/website) — GHSA-r28c-9q8g-f849,
  // patched >=8.5.18. The `vite` (via vitest) devDependency chain resolves
  // its own, older postcss line and is intentionally left alone.
  { package: 'postcss', ancestor: 'next', minVersion: '8.5.18' },
  // nanoid, a dependency of postcss which is itself a dependency of next
  // (apps/website) — GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8, patched
  // >=3.3.18. The `vite` devDependency chain's older postcss/nanoid line is
  // intentionally left alone.
  { package: 'nanoid', ancestor: 'next', minVersion: '3.3.18' },
];

describe('resolved dependency versions clear known high-severity advisories on their specific flagged path (lockfile regression)', () => {
  for (const {
    package: pkg,
    ancestor,
    minVersion,
  } of PATCHED_MINIMUMS_UNDER_ANCESTOR) {
    it(`${pkg} resolves to >= ${minVersion} under ${ancestor} in the workspace lockfile`, () => {
      const versions = resolvedVersionsUnderAncestor(pkg, ancestor);

      expect(versions.length).toBeGreaterThan(0);
      for (const version of versions) {
        expect(
          versionAtLeast(version, minVersion),
          `expected ${pkg}@${version} (under ${ancestor}) to be >= ${minVersion}`,
        ).toBe(true);
      }
    });
  }
});

// These experiments are independent npm projects. Root workspace overrides
// cannot protect them; each committed npm lock must select the patched code.
// Selected packages are checked throughout the lock, including development paths.
// Minimums every experiment shares through its MCP SDK dependency.
const EXPERIMENT_SHARED_MINIMUMS: readonly (readonly [string, string])[] = [
  ['@modelcontextprotocol/sdk', '1.32.0'],
  ['fast-uri', '3.1.9'],
  ['body-parser', '2.4.0'],
  ['proxy-addr', '2.0.8'],
  ['hono', '4.13.11'],
  ['ip-address', '10.7.4'],
  // GHSA-frvp-7c67-39w9 (patched >=1.19.15) and GHSA-rmxm-3fg6-px4f
  // (patched >=2.1.3). The SDK accepts `^1.19.9 || ^2.0.5`, so the patched
  // 2.x line is inside its declared range.
  ['@hono/node-server', '2.1.3'],
];

// Minimums that apply only where the experiment's own development tooling
// resolves the package (host-probe runs its tests with vitest).
const EXPERIMENT_EXTRA_MINIMUMS: Readonly<
  Record<string, readonly (readonly [string, string])[]>
> = {
  'host-probe': [
    // vitest's vite line: GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw,
    // GHSA-587h-7wmj-h5pm, GHSA-9jrq-w75r-8gcw, GHSA-rq7h-c2jc-7f22
    // (affected 8.0.0 - 8.1.5).
    ['vite', '8.1.6'],
    // GHSA-68fv-2mgg-jv7q, patched >=1.2.2.
    ['source-map-js', '1.2.2'],
    // GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8, patched >=3.3.18.
    ['nanoid', '3.3.18'],
    // GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 (affected <=4.1.11).
    ['@vitest/mocker', '4.1.12'],
    // GHSA-fxqj-rqcc-2cmp (affected <=8.5.22), patched >=8.5.23.
    ['postcss', '8.5.23'],
  ],
};

describe('standalone experiment security resolutions', () => {
  for (const experiment of ['channel-probe', 'channel-uat', 'host-probe']) {
    it(`${experiment} resolves patched dependencies throughout its lockfile`, () => {
      const lock = JSON.parse(
        readFileSync(
          new URL(
            `../experiments/${experiment}/package-lock.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      );
      expect(lock, `${experiment}: expected a parsed npm lockfile`).toBeTypeOf(
        'object',
      );
      expect(
        lock,
        `${experiment}: expected npm lockfile packages map`,
      ).toHaveProperty('packages');
      expect(
        lock.packages,
        `${experiment}: packages must be a record`,
      ).toBeTypeOf('object');
      expect(
        lock.packages,
        `${experiment}: packages must not be null`,
      ).not.toBeNull();
      expect(
        Array.isArray(lock.packages),
        `${experiment}: packages must not be an array`,
      ).toBe(false);
      for (const [pkg, minimum] of [
        ...EXPERIMENT_SHARED_MINIMUMS,
        ...(EXPERIMENT_EXTRA_MINIMUMS[experiment] ?? []),
      ]) {
        const versions: string[] = Object.entries(lock.packages)
          .filter(([key]) => key.endsWith(`node_modules/${pkg}`))
          .map(([, value]) => {
            if (
              typeof value !== 'object' ||
              value === null ||
              !('version' in value) ||
              typeof value.version !== 'string'
            ) {
              throw new Error(`Missing resolved version for ${pkg}`);
            }
            return value.version;
          });
        expect(versions.length, pkg).toBeGreaterThan(0);
        for (const version of versions) {
          expect(
            versionAtLeast(version, minimum),
            `${pkg}@${version} must be >=${minimum}`,
          ).toBe(true);
        }
      }
    });
  }
});

/**
 * Exercise the real CLI against a loopback bulk-advisory registry. Copying the
 * build inputs and lockfile preserves workspace resolution without installing
 * packages or asking a real registry about a synthetic advisory.
 */
describe('bundled dependency advisory gate', () => {
  async function runFixture({
    packageName = 'lodash-es',
    addToBundle = false,
    aliasRoot = false,
    deferredConfig = false,
    implicitBundle = false,
    brokenBuild = false,
    unusedSelector = false,
    pluginBundle = false,
    missingMetadata = false,
    overlappingFormats = false,
    workspaceImport = false,
    otherVersion = false,
    allowlisted = false,
    outage = false,
  } = {}) {
    const repo = path.resolve(import.meta.dirname, '..');
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'bundled-audit-'));
    for (const relative of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'scripts/check-dependency-audit.mjs',
      'scripts/publish-release-packages.mjs',
      'scripts/audit-allowlist.json',
      ...PACKAGE_DIRS.flatMap((dir: string) => [dir + '/package.json']),
      ...PACKAGE_DIRS.map((dir: string) => dir + '/tsup.config.ts').filter(
        (file: string) => existsSync(path.join(repo, file)),
      ),
    ]) {
      mkdirSync(path.dirname(path.join(fixture, relative)), {
        recursive: true,
      });
      cpSync(path.join(repo, relative), path.join(fixture, relative));
    }
    symlinkSync(
      path.join(repo, 'node_modules'),
      path.join(fixture, 'node_modules'),
      'dir',
    );
    // Minimal real entries exercise tsup's externalization and injected code,
    // without rebuilding the application's unrelated runtime in every fixture.
    for (const dir of PACKAGE_DIRS) {
      if (!existsSync(path.join(fixture, dir, 'tsup.config.ts'))) continue;
      mkdirSync(path.join(fixture, dir, 'src'), { recursive: true });
      writeFileSync(
        path.join(fixture, dir, 'src/index.ts'),
        dir === 'libs/core'
          ? "export * from 'cel-js';\n"
          : 'export const location = import.meta.url;\n',
      );
      // Preserve the package's actual dependency links, allowing tsup to see
      // development imports just as it does in the published build.
      mkdirSync(path.join(fixture, dir, 'node_modules'), { recursive: true });
      const modules = path.join(repo, dir, 'node_modules');
      for (const name of readdirSync(modules)) {
        const target = path.join(fixture, dir, 'node_modules', name);
        if (name === '@agentmonitors') {
          // Workspace imports must use this fixture's build, never an existing
          // dist directory reachable through the original workspace symlinks.
          mkdirSync(target, { recursive: true });
          for (const child of readdirSync(path.join(modules, name))) {
            const workspace = PACKAGE_DIRS.find(
              (candidate: string) =>
                JSON.parse(
                  readFileSync(
                    path.join(repo, candidate, 'package.json'),
                    'utf8',
                  ),
                ).name === `@agentmonitors/${child}`,
            );
            symlinkSync(
              workspace
                ? path.join(fixture, workspace)
                : path.join(modules, name, child),
              path.join(target, child),
              'dir',
            );
          }
        } else {
          symlinkSync(path.join(modules, name), target, 'dir');
        }
      }
    }

    if (implicitBundle) {
      const configPath = path.join(fixture, 'libs/core/tsup.config.ts');
      writeFileSync(
        configPath,
        readFileSync(configPath, 'utf8').replace(/ {2}noExternal:.*\n/, ''),
      );
    }
    if (brokenBuild) {
      // Old output must never stand in for a build whose current source fails.
      execFileSync(
        process.execPath,
        [
          path.join(repo, 'node_modules/tsup/dist/cli-default.js'),
          '--metafile',
        ],
        {
          cwd: path.join(fixture, 'libs/core'),
          timeout: 20_000,
          stdio: 'pipe',
        },
      );
      writeFileSync(
        path.join(fixture, 'libs/core/src/index.ts'),
        "export * from 'missing-fixture-package';",
      );
    }
    if (pluginBundle) {
      const dir = 'plugins/source-schedule';
      symlinkSync(
        path.join(repo, 'libs/core/node_modules/cel-js'),
        path.join(fixture, dir, 'node_modules/cel-js'),
        'dir',
      );
      writeFileSync(
        path.join(fixture, dir, 'src/index.ts'),
        "export * from 'cel-js';\n",
      );
      writeFileSync(
        path.join(fixture, 'libs/core/src/index.ts'),
        'export const empty = true;\n',
      );
    }
    if (workspaceImport) {
      writeFileSync(
        path.join(fixture, 'apps/cli/src/index.ts'),
        "export * from '@agentmonitors/core';\n",
      );
    }
    // The fixture's build uses real tsup for every package in dependency order.
    // Minimal sources need no declaration rollup, unlike the full root build.
    const rootManifestPath = path.join(fixture, 'package.json');
    const rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8'));
    rootManifest.scripts.build = 'node scripts/build-audit-fixture.mjs';
    writeFileSync(rootManifestPath, JSON.stringify(rootManifest));
    writeFileSync(
      path.join(fixture, 'scripts/build-audit-fixture.mjs'),
      `
      import { execFileSync } from 'node:child_process';
      import { existsSync } from 'node:fs';
      import path from 'node:path';
      import { PACKAGE_DIRS } from './publish-release-packages.mjs';
      for (const dir of PACKAGE_DIRS) {
        if (existsSync(path.join(dir, 'tsup.config.ts'))) {
          execFileSync(process.execPath, [path.resolve('node_modules/tsup/dist/cli-default.js')], { cwd: dir, stdio: 'pipe', timeout: 20000 });
        }
      }
    `,
    );
    // A fixture package and child provide real bundled files and locked audit
    // identities. Aliases must resolve to canonical registry package names.
    const lockPath = path.join(fixture, 'pnpm-lock.yaml');
    const lock = parse(readFileSync(lockPath, 'utf8'));
    const bundleName = aliasRoot ? 'bundle-alias' : 'future-bundle';
    lock.importers['libs/core'].devDependencies[bundleName] = {
      specifier: aliasRoot ? 'npm:future-bundle@1.0.0' : '1.0.0',
      version: aliasRoot ? 'future-bundle@1.0.0' : '1.0.0',
    };
    lock.packages['future-bundle@1.0.0'] = {
      resolution: { integrity: 'sha512-fixture' },
    };
    lock.packages['future-child@2.0.0'] = {
      resolution: { integrity: 'sha512-fixture' },
    };
    lock.snapshots['future-bundle@1.0.0'] = {
      dependencies: { 'future-child': '2.0.0' },
    };
    lock.snapshots['future-child@2.0.0'] = {};
    if (otherVersion) {
      // The registry receives both versions, but only 0.8.2 is in the bundle.
      lock.importers['.'].devDependencies['other-cel'] = {
        specifier: 'npm:cel-js@99.0.0',
        version: 'cel-js@99.0.0',
      };
      lock.packages['cel-js@99.0.0'] = {
        resolution: { integrity: 'sha512-fixture' },
      };
      lock.snapshots['cel-js@99.0.0'] = {};
    }
    writeFileSync(lockPath, stringify(lock));
    const modules = path.join(fixture, 'libs/core/node_modules');
    for (const [name, version, source] of [
      ['future-bundle', '1.0.0', "export * from 'future-child';"],
      ['future-child', '2.0.0', 'export const child = 42;'],
    ]) {
      const dir = path.join(
        modules,
        name === 'future-bundle' ? bundleName : name,
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, version, type: 'module', main: 'index.js' }),
      );
      writeFileSync(path.join(dir, 'index.js'), source);
    }
    if (addToBundle) {
      writeFileSync(
        path.join(fixture, 'libs/core/src/index.ts'),
        `export * from 'cel-js';\nexport * from '${bundleName}';\n`,
      );
    }
    if (addToBundle) {
      const configPath = path.join(fixture, 'libs/core/tsup.config.ts');
      writeFileSync(
        configPath,
        readFileSync(configPath, 'utf8').replace(
          'noExternal: [',
          `noExternal: ['${bundleName}',`,
        ),
      );
    }
    if (missingMetadata || overlappingFormats) {
      const configPath = path.join(fixture, 'libs/core/tsup.config.ts');
      const content = readFileSync(configPath, 'utf8');
      writeFileSync(
        configPath,
        missingMetadata
          ? content.replace(
              '  entry:',
              '  esbuildOptions(options) { options.metafile = false; },\n  entry:',
            )
          : content
              .replace('defineConfig({', 'defineConfig([{')
              .replace(
                /}\);\s*$/,
                '}, { entry: ["src/index.ts"], format: ["esm"] }]);\n',
              ),
      );
    }
    if (unusedSelector) {
      const configPath = path.join(fixture, 'libs/core/tsup.config.ts');
      writeFileSync(
        configPath,
        readFileSync(configPath, 'utf8').replace(
          'noExternal: [',
          "noExternal: ['unused-fixture',",
        ),
      );
    }
    if (deferredConfig) {
      const configPath = path.join(fixture, 'libs/core/tsup.config.ts');
      writeFileSync(
        configPath,
        readFileSync(configPath, 'utf8')
          .replace(
            'export default defineConfig({',
            'export default Promise.resolve(defineConfig({',
          )
          .replace(/}\);\s*$/, '}));\n'),
      );
    }
    if (implicitBundle || packageName === 'tsup' || pluginBundle) {
      const dir = pluginBundle
        ? 'plugins/source-schedule'
        : implicitBundle
          ? 'libs/core'
          : 'apps/cli';
      execFileSync(
        process.execPath,
        [path.join(repo, 'node_modules/tsup/dist/cli-default.js')],
        {
          cwd: path.join(fixture, dir),
          timeout: 20_000,
          stdio: 'pipe',
        },
      );
      const map = JSON.parse(
        readFileSync(
          path.join(
            fixture,
            dir,
            'dist',
            dir === 'apps/cli' ? 'index.cjs.map' : 'index.js.map',
          ),
          'utf8',
        ),
      );
      expect(
        map.sources.some((source: string) =>
          source.includes(
            packageName === 'tsup' ? '/tsup/assets/cjs_shims.js' : '/cel-js/',
          ),
        ),
      ).toBe(true);
    }
    const id = 'GHSA-0000-0000-0000';
    if (allowlisted) {
      writeFileSync(
        path.join(fixture, 'scripts/audit-allowlist.json'),
        JSON.stringify({
          exceptions: [
            {
              id,
              package: packageName,
              reason: 'Synthetic fixture only',
              expires: '2099-01-01',
            },
          ],
        }),
      );
    }
    const submissions: Record<string, string[]>[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      let body = Buffer.concat(chunks);
      if (request.headers['content-encoding'] === 'gzip')
        body = gunzipSync(body);
      const payload = JSON.parse(body.toString() || '{}');
      submissions.push(payload);
      const unavailable = outage && payload['cel-js'];
      response.writeHead(unavailable ? 503 : 200, {
        'content-type': 'application/json',
      });
      response.end(
        JSON.stringify(
          unavailable
            ? { error: 'Synthetic outage' }
            : payload[packageName]
              ? {
                  [packageName]: [
                    {
                      id: 999999999,
                      url: `https://github.com/advisories/${id}`,
                      title: 'Synthetic bundled advisory',
                      severity: 'high',
                      vulnerable_versions: otherVersion ? '99.0.0' : '*',
                      cwe: [],
                      cvss: { score: 8, vectorString: null },
                    },
                  ],
                }
              : {},
        ),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected loopback port');
      const child = spawn(
        process.execPath,
        ['scripts/check-dependency-audit.mjs'],
        {
          cwd: fixture,
          env: {
            ...process.env,
            pnpm_config_registry: `http://127.0.0.1:${address.port}`,
            pnpm_config_fetch_retries: '0',
            // Synthetic lock entries intentionally differ from the linked install.
            // Never let pnpm replace that shared installation before fixture builds.
            pnpm_config_verify_deps_before_run: 'warn',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      return { exit, output, submissions, id };
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }

  it('rejects a high advisory for a default-bundled dev import without noExternal', async () => {
    const result = await runFixture({
      packageName: 'cel-js',
      implicitBundle: true,
    });
    expect(
      result.submissions.some((payload) =>
        payload['cel-js']?.includes('0.8.2'),
      ),
    ).toBe(true);
    expect(result.output).toContain(result.id);
    expect(result.exit, result.output).toBe(1);
  }, 60_000);

  it('rejects a high advisory for tsup code injected by shims', async () => {
    const result = await runFixture({ packageName: 'tsup' });
    expect(
      result.submissions.some((payload) => payload.tsup?.includes('8.5.1')),
    ).toBe(true);
    expect(result.output).toContain(result.id);
    expect(result.exit, result.output).toBe(1);
  }, 60_000);

  it('audits default-bundled inputs from a published plugin', async () => {
    const result = await runFixture({
      packageName: 'cel-js',
      pluginBundle: true,
    });
    expect(result.output).toContain(result.id);
    expect(result.exit, result.output).toBe(1);
  }, 60_000);

  it('fails on a broken build even when stale metadata exists', async () => {
    const result = await runFixture({ brokenBuild: true });
    expect(result.exit, result.output).not.toBe(0);
    expect(result.submissions).toHaveLength(0);
    expect(result.output).toContain('missing-fixture-package');
  }, 60_000);

  it('reports unused noExternal intent without failing a clean audit', async () => {
    const result = await runFixture({
      packageName: 'future-child',
      unusedSelector: true,
    });
    expect(result.exit, result.output).toBe(0);
    expect(result.output).toContain('unused-fixture');
  }, 60_000);

  it('fails closed when a build emits no metafile', async () => {
    const result = await runFixture({ missingMetadata: true });
    expect(result.exit, result.output).not.toBe(0);
    expect(result.submissions).toHaveLength(0);
    expect(result.output).toContain('metafile-esm.json');
  }, 60_000);

  it('rejects configs whose metafiles could overwrite each other', async () => {
    const result = await runFixture({ overlappingFormats: true });
    expect(result.exit, result.output).not.toBe(0);
    expect(result.submissions).toHaveLength(0);
    expect(result.output).toContain('Overlapping bundled audit formats');
  }, 60_000);

  it('builds workspace inputs before bundling the CLI on a fresh checkout', async () => {
    const result = await runFixture({
      packageName: 'cel-js',
      workspaceImport: true,
    });
    expect(result.output).toContain(result.id);
    expect(result.exit, result.output).toBe(1);
  }, 60_000);

  it('excludes a synthetic advisory for another resolved version of a bundled package', async () => {
    const result = await runFixture({
      packageName: 'cel-js',
      otherVersion: true,
    });
    expect(
      result.submissions.some(
        (payload) =>
          payload['cel-js']?.includes('0.8.2') &&
          payload['cel-js']?.includes('99.0.0'),
      ),
    ).toBe(true);
    expect(result.exit, result.output).toBe(0);
  }, 60_000);

  it('rejects a synthetic high advisory against the resolved bundled lodash version', async () => {
    const result = await runFixture();
    expect(result.submissions.length).toBeGreaterThan(0);
    expect(result.output).toContain(result.id);
    expect(result.exit).toBe(1);
    expect(
      result.submissions.some((payload) =>
        payload['lodash-es']?.includes('4.18.1'),
      ),
    ).toBe(true);
  }, 60_000);

  it('audits the transitive inputs of an imported noExternal package', async () => {
    const before = await runFixture({ packageName: 'future-child' });
    expect(before.exit, before.output).toBe(0);
    const after = await runFixture({
      packageName: 'future-child',
      addToBundle: true,
    });
    expect(after.output).toContain(after.id);
    expect(after.exit).toBe(1);
  }, 60_000);

  it('follows an aliased noExternal root to its canonical registry dependency closure', async () => {
    const result = await runFixture({
      packageName: 'future-child',
      addToBundle: true,
      aliasRoot: true,
    });
    expect(result.output).toContain(result.id);
    expect(result.exit).toBe(1);
  }, 60_000);

  it('rejects an unsupported deferred build config instead of treating it as no bundled packages', async () => {
    const result = await runFixture({ deferredConfig: true });
    expect(result.exit).not.toBe(0);
    expect(result.output).toContain('Unsupported bundled audit build config');
  }, 60_000);

  it('still blocks synthetic production advisories', async () => {
    const result = await runFixture({ packageName: 'zod' });
    expect(result.output).toContain(result.id);
    expect(result.exit).toBe(1);
  }, 60_000);

  it('applies the existing scoped allowlist to bundled advisories', async () => {
    const result = await runFixture({ allowlisted: true });
    expect(result.output).toContain('Suppressed by reviewed exception');
    expect(result.exit, result.output).toBe(0);
  }, 60_000);

  it('fails closed when only the bundled audit endpoint is unavailable', async () => {
    const result = await runFixture({ outage: true });
    expect(result.submissions.some((payload) => payload['cel-js'])).toBe(true);
    expect(result.exit).not.toBe(0);
    expect(result.output).toContain('audit tooling failed');
  }, 60_000);
});

/** Advisory scope follows resolved versions, even when tooling uses another line. */
describe('bundledAuditReport', () => {
  const inventory = new Map([['example-pkg', new Set(['2.0.0'])]]);

  it('keeps only findings for the shipped version and excludes unrelated tooling', () => {
    const report = bundledAuditReport(
      {
        advisories: {
          old: advisory({ findings: [{ version: '1.0.0' }] }),
          shipped: advisory({
            findings: [{ version: '1.0.0' }, { version: '2.0.0' }],
          }),
          tooling: advisory({
            module_name: 'tool-only',
            findings: [{ version: '2.0.0' }],
          }),
        },
      },
      inventory,
    );
    expect(Object.keys(report.advisories)).toEqual(['shipped']);
    expect(report.advisories.shipped.findings).toEqual([{ version: '2.0.0' }]);
  });

  it.each([undefined, [], [{}]])(
    'rejects missing version evidence: %j',
    (findings) => {
      expect(() =>
        bundledAuditReport(
          { advisories: { selected: advisory({ findings }) } },
          inventory,
        ),
      ).toThrow(/Missing bundled audit finding versions/);
    },
  );
});
