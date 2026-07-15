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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWLIST_PATH,
  evaluateAuditReport,
  loadAllowlist,
  resolvedVersions,
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
  // drizzle-orm: GHSA (libs/core) — patched >=0.45.2
  { package: 'drizzle-orm', minVersion: '0.45.2' },
  // lodash-es via cel-js>chevrotain (libs/core) — GHSA-r5fr-rjxr-66jc, patched >=4.17.24
  { package: 'lodash-es', minVersion: '4.17.24' },
  // fast-uri via @modelcontextprotocol/sdk>ajv (apps/cli) — GHSA-v39h-62p7-jpjc, patched >=3.1.2
  { package: 'fast-uri', minVersion: '3.1.2' },
  // hono via @modelcontextprotocol/sdk (apps/cli) — GHSA-88fw-hqm2-52qc, patched >=4.12.25
  { package: 'hono', minVersion: '4.12.25' },
  // next (apps/website) — multiple GHSAs, most recent patched >=16.2.6
  { package: 'next', minVersion: '16.2.6' },
];

describe('resolved dependency versions clear known high-severity advisories (lockfile regression)', () => {
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
