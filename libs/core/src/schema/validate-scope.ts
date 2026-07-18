import { Validator, type Schema } from '@cfworker/json-schema';
import type { JsonSchema } from '../observation/types.js';

/**
 * Validate a monitor's `scope` object against a source's `scopeSchema` fragment
 * using full JSON Schema (draft-07) semantics — types, enums, `required`, `items`,
 * and so on — not just required-field presence.
 *
 * Returns a list of human-readable error messages; an empty array means the scope
 * is valid for that source.
 *
 * Uses `@cfworker/json-schema`, which validates by walking the schema at runtime
 * rather than compiling with the `Function` constructor, so it is safe under
 * restrictive CSP and Workers-style environments.
 *
 * @param scope - The monitor's source-specific `scope` object.
 * @param scopeSchema - The source's `scopeSchema` JSON Schema fragment.
 */
export function validateScope(
  scope: Record<string, unknown>,
  scopeSchema: JsonSchema,
): string[] {
  // `JsonSchema` is an opaque `Record<string, unknown>`; cfworker's `Schema` is the
  // structured draft type. The cast is safe because a source's `scopeSchema` is, by
  // contract (AP4), a JSON Schema object.
  const validator = new Validator(scopeSchema as unknown as Schema, '7', false);
  const result = validator.validate(scope);
  if (result.valid) return [];

  const messages = result.errors.map((unit) => {
    const location =
      unit.instanceLocation && unit.instanceLocation !== '#'
        ? unit.instanceLocation.replace(/^#/, 'scope')
        : 'scope';
    return `${location}: ${unit.error}`;
  });

  // cfworker can emit several units for one underlying failure (a leaf error plus
  // its parent keyword); collapse exact duplicates for a cleaner report.
  return [...new Set(messages)];
}

/**
 * Returns the actionable BP3 error when a `change-detection.collection` block is
 * present without `strategy: json-diff` (003 §12), or `undefined` otherwise.
 * Mirrors the schema's `if/then` rule with a clearer, author-facing message than
 * cfworker's opaque "Instance does not match json-diff". Source-agnostic (any
 * source exposing `change-detection`), so it lives on the shared validate path.
 */
export function changeDetectionCollectionError(
  watchConfig: Record<string, unknown>,
): string | undefined {
  const cd = watchConfig['change-detection'];
  if (cd === null || typeof cd !== 'object' || Array.isArray(cd)) {
    return undefined;
  }
  const cdObj = cd as Record<string, unknown>;
  if (cdObj['collection'] === undefined) return undefined;
  const strategy = cdObj['strategy'];
  if (strategy === 'json-diff') return undefined;
  return 'change-detection.collection requires strategy: json-diff';
}

/**
 * Returns `true` iff `timeZone` is accepted by `Intl.DateTimeFormat` as an IANA
 * time zone name. Construction throws a `RangeError` for an invalid zone (e.g. a
 * typo like `"America/New_Yrok"`), which is the cheapest available check — Node
 * ships the full IANA database, so this does not depend on a hardcoded list.
 * Shared between authoring-time validation ({@link invalidTimezoneError}, the
 * `rollup` notify schema in `monitor-schema.ts`) and the runtime defensive check
 * in `service.ts` (`scheduleForMonitor`, `dispatchRollup`) so both use IDENTICAL
 * validity semantics (issue #297).
 */
export function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    // Intl constructors are callable without `new` per ECMA-402; called only to
    // trigger the RangeError an invalid zone throws (mirrors monitor-schema.ts's
    // rollupNotifySchema.timezone refinement).
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns `true` iff `scopeSchema` declares a `timezone` property (i.e. the
 * source's own contract gives that key meaning). Most bundled `scopeSchema`s do
 * not set `additionalProperties: false` (AP4 leaves that to each source), so an
 * unrelated source's scope can carry an extra `timezone` key that JSON Schema
 * silently accepts — {@link invalidTimezoneError} must not reject THAT as an
 * invalid IANA name; it isn't the schedule source's `scope.timezone` at all.
 */
function scopeSchemaDeclaresTimezone(scopeSchema: JsonSchema): boolean {
  const properties = scopeSchema['properties'];
  return (
    properties !== null &&
    typeof properties === 'object' &&
    !Array.isArray(properties) &&
    'timezone' in properties
  );
}

/**
 * Returns an actionable error when `scope.timezone` is present but not a valid
 * IANA time zone name, or `undefined` otherwise (issue #297). Without this,
 * `Intl.DateTimeFormat` throws deep inside cron scheduling at runtime — well
 * after authoring — aborting the whole tick instead of naming the bad monitor.
 * Source-agnostic (mirrors {@link changeDetectionCollectionError}), but gated on
 * `scopeSchema` actually declaring a `timezone` property ({@link
 * scopeSchemaDeclaresTimezone}) — a source whose scope doesn't define one (e.g.
 * `file-fingerprint`) must never have an unrelated extra `timezone` key rejected
 * with a schedule-specific IANA error (PR #433 review).
 */
export function invalidTimezoneError(
  watchConfig: Record<string, unknown>,
  scopeSchema: JsonSchema,
): string | undefined {
  if (!scopeSchemaDeclaresTimezone(scopeSchema)) return undefined;
  const timezone = watchConfig['timezone'];
  if (timezone === undefined) return undefined;
  // A wrong-typed `timezone` is already reported by the JSON Schema `type:
  // "string"` check in validateScope(); avoid a redundant/confusing second error.
  if (typeof timezone !== 'string') return undefined;
  if (isValidIanaTimeZone(timezone)) return undefined;
  return `scope.timezone: "${timezone}" is not a valid IANA time zone name (e.g. "America/New_York", "UTC").`;
}

/**
 * Validate a monitor's `watch` scope (the `watch` block minus `type`) against a
 * source's `scopeSchema`, returning the SAME diagnostics `agentmonitors validate`
 * produces (004 §2.2): the {@link validateScope} schema errors, plus the BP3
 * {@link changeDetectionCollectionError} friendly wrapper for the keyed-collection
 * case (replacing cfworker's opaque conditional-schema `then` noise). Both the
 * `validate` command and the ephemeral `watch declare` path (007 §4.2) call this,
 * so an invalid scope is rejected identically on either path (005 §14.4).
 *
 * @param scope - The monitor's source-specific `scope` object (no `type` key).
 * @param scopeSchema - The source's `scopeSchema` JSON Schema fragment.
 */
export function validateWatchScope(
  scope: Record<string, unknown>,
  scopeSchema: JsonSchema,
): string[] {
  const errors = validateScope(scope, scopeSchema);
  const collectionError = changeDetectionCollectionError(scope);
  const timezoneError = invalidTimezoneError(scope, scopeSchema);
  const supplementalErrors = [collectionError, timezoneError].filter(
    (message): message is string => message !== undefined,
  );
  return supplementalErrors.length > 0
    ? [
        ...supplementalErrors,
        ...errors.filter((message) => !message.includes('then')),
      ]
    : errors;
}
