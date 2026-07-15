// Production-dependency audit gate (Refs #290).
//
// Runs `pnpm audit --prod --audit-level high --json` and fails loudly on any
// high/critical advisory that isn't covered by a reviewed, non-expired entry
// in `scripts/audit-allowlist.json`. This is the "explicit, reviewed
// exception mechanism rather than blanket ignores" from the issue's
// definition of done: an exception only suppresses the exact advisory it
// names, and it stops working (fails the gate) once its `expires` date
// passes, forcing someone to look at it again rather than letting it rot.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..');
export const DEFAULT_ALLOWLIST_PATH = join(__dirname, 'audit-allowlist.json');

const EXPIRES_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {{ id: string, package: string, reason: string, expires: string }} AllowlistEntry
 */

/**
 * Whether `expires` is not just YYYY-MM-DD-shaped but an actual calendar
 * date. The regex alone lets through two dangerously-wrong cases: an
 * out-of-range component (e.g. "2026-13-01", month 13) parses as `Invalid
 * Date` — and since `NaN` compares `false` against everything, an exception
 * with that `expires` would never be treated as expired (a permanent
 * bypass). A rolled-over component (e.g. "2026-02-30") parses *successfully*
 * as March 2nd instead of raising — silently moving the exception's real
 * expiry later than written. Round-tripping through `toISOString` catches
 * both: an invalid date fails the `NaN` check, and a rolled-over date's
 * ISO date component no longer matches the input string.
 *
 * @param {string} expires
 * @returns {boolean}
 */
function isValidCalendarDate(expires) {
  if (!EXPIRES_DATE_PATTERN.test(expires)) return false;
  const parsed = new Date(`${expires}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === expires;
}

/**
 * Throws a descriptive error naming every missing/malformed field, rather
 * than a single generic complaint, so a bad allowlist entry is fixable from
 * the error message alone.
 *
 * @param {unknown} entry
 * @param {string} path
 * @returns {asserts entry is AllowlistEntry}
 */
function assertValidAllowlistEntry(entry, path) {
  const record =
    typeof entry === 'object' && entry !== null
      ? /** @type {Record<string, unknown>} */ (entry)
      : {};

  /** @type {string[]} */
  const problems = [];
  if (typeof record.id !== 'string' || record.id.length === 0) {
    problems.push('a non-empty string "id" (GitHub advisory id)');
  }
  if (typeof record.package !== 'string' || record.package.length === 0) {
    problems.push('a non-empty string "package" (npm package name)');
  }
  if (typeof record.reason !== 'string' || record.reason.length === 0) {
    problems.push('a non-empty string "reason"');
  }
  if (
    typeof record.expires !== 'string' ||
    !isValidCalendarDate(record.expires)
  ) {
    problems.push('a valid calendar date "expires" in YYYY-MM-DD format');
  }

  if (problems.length > 0) {
    throw new Error(
      `${path}: every exception needs ${problems.join(', ')} — got ${JSON.stringify(entry)}`,
    );
  }
}

/**
 * Loads and validates the audit exception allowlist.
 *
 * @param {string} [path]
 * @returns {AllowlistEntry[]}
 */
export function loadAllowlist(path = DEFAULT_ALLOWLIST_PATH) {
  const raw = readFileSync(path, 'utf8');
  /** @type {unknown} */
  const data = JSON.parse(raw);
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray(/** @type {{ exceptions?: unknown }} */ (data).exceptions)
  ) {
    throw new Error(`${path} must be a JSON object with an "exceptions" array`);
  }
  const exceptions = /** @type {{ exceptions: unknown[] }} */ (data).exceptions;
  for (const entry of exceptions) {
    assertValidAllowlistEntry(entry, path);
  }
  return /** @type {AllowlistEntry[]} */ (exceptions);
}

/**
 * `pnpm audit --json` reports a *tooling* failure (registry unreachable,
 * auth failure, malformed response, etc.) by writing `{"error": {"code":
 * ..., "message": ...}}` to stdout — with no `advisories` key at all, often
 * alongside a non-zero exit. Without this check, `Object.values(report
 * .advisories ?? {})` in `evaluateAuditReport` would treat that shape as
 * "zero advisories" — a false "clean" result for a security gate, which is
 * the opposite of what actually happened (the audit never ran). Throws
 * instead, so a network/registry outage fails the gate loudly rather than
 * silently reporting success.
 *
 * @param {unknown} report
 * @returns {{ advisories: Record<string, unknown> }}
 */
export function assertValidAuditReport(report) {
  const record =
    typeof report === 'object' && report !== null
      ? /** @type {Record<string, unknown>} */ (report)
      : undefined;

  if (record?.error !== undefined) {
    const errorRecord =
      typeof record.error === 'object' && record.error !== null
        ? /** @type {Record<string, unknown>} */ (record.error)
        : {};
    throw new Error(
      `audit tooling failed, not a clean result: ${errorRecord.message ?? JSON.stringify(record.error)}`,
    );
  }

  if (
    record === undefined ||
    typeof record.advisories !== 'object' ||
    record.advisories === null ||
    Array.isArray(record.advisories)
  ) {
    throw new Error(
      `audit tooling failed, not a clean result: unexpected \`pnpm audit\` report shape (no "advisories" object) — ${JSON.stringify(report)}`,
    );
  }

  return /** @type {{ advisories: Record<string, unknown> }} */ (record);
}

/**
 * Shells out to the real `pnpm audit` CLI and returns its parsed, validated
 * JSON report. `pnpm audit` exits non-zero both when it finds advisories
 * at/above `--audit-level` *and* on a tooling failure, so the report has to
 * be read from the error too — `assertValidAuditReport` is what tells those
 * two cases apart. `cwd` is pinned to the repo root (rather than inherited
 * from `process.cwd()`) so running the gate from a subdirectory still
 * audits this workspace, not whatever pnpm project happens to be
 * discoverable from the caller's cwd.
 *
 * @param {{ cwd?: string }} [options]
 * @returns {{ advisories: Record<string, unknown> }}
 */
export function runPnpmAudit({ cwd = REPO_ROOT } = {}) {
  /** @type {unknown} */
  let parsed;
  try {
    const stdout = execFileSync(
      'pnpm',
      ['audit', '--prod', '--audit-level', 'high', '--json'],
      { encoding: 'utf8', cwd },
    );
    parsed = JSON.parse(stdout);
  } catch (error) {
    const stdout = /** @type {{ stdout?: string }} */ (error).stdout;
    if (typeof stdout === 'string' && stdout.trim().length > 0) {
      parsed = JSON.parse(stdout);
    } else {
      throw error;
    }
  }
  return assertValidAuditReport(parsed);
}

/**
 * @typedef {{
 *   github_advisory_id: string,
 *   module_name: string,
 *   severity: string,
 *   title: string,
 *   url: string,
 * }} Advisory
 */

/**
 * A date-only (YYYY-MM-DD) `expires` value is valid *through* that whole day
 * (UTC) — it expires at the start of the *next* day, not at UTC midnight of
 * the `expires` date itself. Without this, an exception dated "2026-07-14"
 * would already read as expired at any time later that same day.
 *
 * @param {string} expires
 * @returns {Date}
 */
function startOfDayAfterExpiry(expires) {
  const startOfExpiryDay = new Date(`${expires}T00:00:00.000Z`);
  return new Date(startOfExpiryDay.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Fails *closed*: an `expires` that can't be parsed into a real calendar
 * date (see `isValidCalendarDate`) is treated as already expired, not as
 * "never expires". `loadAllowlist` should already reject such an entry
 * before it ever reaches here, but this is a security gate — a caller that
 * bypasses that validation (e.g. constructing exceptions directly, as unit
 * tests do) must not get a silent, permanent bypass out of it.
 *
 * @param {{ expires: string }} exception
 * @param {Date} now
 * @returns {boolean}
 */
function isExpired(exception, now) {
  const cutoff = startOfDayAfterExpiry(exception.expires).getTime();
  if (Number.isNaN(cutoff)) return true;
  return now.getTime() >= cutoff;
}

/**
 * Cross-references a `pnpm audit --json` report against the allowlist.
 *
 * An exception only suppresses its advisory while both (a) `now` is on or
 * before its `expires` date (see `isExpired`), and (b) its `package` matches
 * the advisory's `module_name` — a mismatched package is treated as not
 * suppressing at all, so a copy-paste error in the allowlist can't
 * accidentally suppress an unrelated advisory that happens to share a GHSA
 * id (vanishingly unlikely, but cheap to guard against explicitly). An
 * expired exception is reported separately (and always counts as a failure)
 * regardless of whether its advisory still appears in the report, so stale
 * entries can't silently persist forever.
 *
 * @param {{ advisories?: Record<string, unknown> }} report
 * @param {AllowlistEntry[]} exceptions
 * @param {{ now?: Date }} [options]
 */
export function evaluateAuditReport(
  report,
  exceptions,
  { now = new Date() } = {},
) {
  const advisories = /** @type {Advisory[]} */ (
    Object.values(report.advisories ?? {})
  );
  const byId = new Map(
    exceptions.map((exception) => [exception.id, exception]),
  );

  const expiredExceptions = exceptions.filter((exception) =>
    isExpired(exception, now),
  );
  const expiredIds = new Set(
    expiredExceptions.map((exception) => exception.id),
  );

  /** @type {Advisory[]} */
  const blocking = [];
  /** @type {Array<{ advisory: Advisory, exception: AllowlistEntry }>} */
  const suppressed = [];

  for (const advisory of advisories) {
    if (advisory.severity !== 'high' && advisory.severity !== 'critical') {
      continue;
    }
    const exception = byId.get(advisory.github_advisory_id);
    const covers =
      exception !== undefined &&
      exception.package === advisory.module_name &&
      !expiredIds.has(exception.id);
    if (covers) {
      suppressed.push({
        advisory,
        exception: /** @type {AllowlistEntry} */ (exception),
      });
    } else {
      blocking.push(advisory);
    }
  }

  return { blocking, suppressed, expiredExceptions };
}

/**
 * Returns the distinct resolved versions of `packageName` across the entire
 * workspace lockfile, by shelling out to the real `pnpm why --json` (the
 * actual resolution pnpm computed from `pnpm-lock.yaml`), rather than
 * hand-parsing the lockfile. Used as a regression check that a patched
 * version is genuinely selected, independent of whether the audit registry
 * itself is reachable.
 *
 * @param {string} packageName
 * @param {{ cwd?: string }} [options]
 * @returns {string[]}
 */
export function resolvedVersions(packageName, { cwd = REPO_ROOT } = {}) {
  const stdout = execFileSync('pnpm', ['why', packageName, '--json'], {
    encoding: 'utf8',
    cwd,
  });
  /** @type {Array<{ version: string }>} */
  const entries = JSON.parse(stdout);
  return [...new Set(entries.map((entry) => entry.version))];
}

/**
 * Minimal dotted-numeric version comparator (no pre-release/build-metadata
 * support — none of the packages this gate tracks need it). Sufficient for
 * asserting "the resolved version is at least the patched one".
 *
 * @param {string} actual
 * @param {string} minimum
 * @returns {boolean}
 */
export function versionAtLeast(actual, minimum) {
  const parse = (/** @type {string} */ version) =>
    version
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10));
  const a = parse(actual);
  const b = parse(minimum);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  return true;
}

function formatAdvisory(advisory) {
  return `  - [${advisory.severity}] ${advisory.module_name}: ${advisory.title} (${advisory.github_advisory_id})\n    ${advisory.url}`;
}

export function main() {
  const report = runPnpmAudit();
  const exceptions = loadAllowlist();
  const { blocking, suppressed, expiredExceptions } = evaluateAuditReport(
    report,
    exceptions,
  );

  if (suppressed.length > 0) {
    console.log(
      'Suppressed by reviewed exception (scripts/audit-allowlist.json):',
    );
    for (const { advisory, exception } of suppressed) {
      console.log(formatAdvisory(advisory));
      console.log(
        `    reason: ${exception.reason} (expires ${exception.expires})`,
      );
    }
  }

  let failed = false;

  if (expiredExceptions.length > 0) {
    failed = true;
    console.error('\nExpired audit exceptions must be renewed or removed:');
    for (const exception of expiredExceptions) {
      console.error(
        `  - ${exception.id} (${exception.package}) expired ${exception.expires}: ${exception.reason}`,
      );
    }
  }

  if (blocking.length > 0) {
    failed = true;
    console.error(
      '\nUnresolved high/critical production-dependency advisories:',
    );
    for (const advisory of blocking) {
      console.error(formatAdvisory(advisory));
    }
    console.error(
      '\nUpgrade or override the dependency (see pnpm-workspace.yaml `overrides`), or add a ' +
        'narrowly scoped, reviewed exception with an expiry date to scripts/audit-allowlist.json.',
    );
  }

  if (!failed) {
    console.log(
      'pnpm audit --prod --audit-level high: clean (no unresolved high/critical advisories).',
    );
  }

  process.exitCode = failed ? 1 : 0;
}

// `file://${process.argv[1]}` string construction isn't portable (notably on
// Windows, where a raw path isn't a valid file-URL segment — drive letters,
// backslashes). Resolve `argv[1]` to an absolute path and convert it through
// `pathToFileURL` instead, matching the same entrypoint-detection pattern
// already used in scripts/test-standalone-consumer.mjs.
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainModule) {
  main();
}
