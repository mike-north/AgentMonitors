/**
 * The deterministic **Shape** stage (roadmap G15).
 *
 * Shape runs on the **shared** side of the per-recipient seam, **before** Pace
 * and **before** Diff ([002 §1.1.4–§1.1.5](../../../../docs/specs/002-runtime-delivery.md#114-shape-deterministic-derived-facts)).
 * It does two deterministic things:
 *
 * 1. **Derived facts** — compute author-declared relative/aggregate facts as a
 *    pure function of `(shaped snapshot, injected now)` (capability C41). The
 *    `now` is the runtime-supplied tick clock, never an ambient `Date.now()`
 *    read, so a tick is reproducible and testable with a fixed clock.
 * 2. **Render** — turn the shaped state (snapshot + the facts that hold) into a
 *    stable, byte-identical, markdown-ish text artifact (capability C42/C43)
 *    that the runtime then diffs **instead of** the raw source. The same shaped
 *    state MUST render to byte-identical text run-to-run; instability here
 *    manifests downstream as phantom diffs.
 *
 * The predicate language is **CEL** (a boolean *condition*, not a reshaping
 * expression — jq is reserved for `payload.transform`, §5.2). It is evaluated by
 * `cel-js`, a Chevrotain-based parser/interpreter that does **not** use the
 * `Function` constructor or `eval`, so it is safe under restrictive CSP /
 * Workers-style environments (the same constraint that drove the choice of
 * `@cfworker/json-schema` over `ajv` repo-wide).
 *
 * @see ../../../../docs/specs/001-monitor-definition.md §5.1 (Shape declaration)
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.4–§1.1.5
 * @see ../../../../docs/specs/003-source-plugins.md §2.7 (sources surface raw facts)
 */
import { evaluate as celEvaluate, parse as celParse } from 'cel-js';

/**
 * One author-declared derived-fact rule from a monitor's `shape.derive` list.
 * `name` is the marker surfaced in the rendered artifact; `when` is a CEL
 * boolean predicate over `(snapshot, now)`.
 *
 * @see ../../../../docs/specs/001-monitor-definition.md §5.1
 */
export interface DerivedFactRule {
  /** The marker name surfaced in the rendered artifact (e.g. `revealed`). */
  name: string;
  /** A CEL boolean predicate evaluated over the snapshot plus injected `now`. */
  when: string;
}

/**
 * A derived fact that held for a given `(snapshot, now)`. Only facts whose
 * predicate evaluated to `true` are produced; ordering follows the authored
 * `shape.derive` order so the rendered artifact is stable.
 */
export interface DerivedFact {
  /** The rule's `name` (the marker). */
  name: string;
}

/**
 * The CEL evaluation context for a derived-fact predicate: the shaped snapshot's
 * own fields, plus the runtime-injected `now` (epoch milliseconds). Snapshot
 * fields shadow nothing reserved; `now` is always present.
 */
function buildContext(snapshot: unknown, now: number): Record<string, unknown> {
  const base: Record<string, unknown> =
    snapshot !== null &&
    typeof snapshot === 'object' &&
    !Array.isArray(snapshot)
      ? { ...(snapshot as Record<string, unknown>) }
      : { value: snapshot };
  // `now` is the only time input and it is injected — never an ambient clock.
  // It overrides any snapshot field literally named `now` so a source cannot
  // smuggle wall-clock reasoning into the predicate (003 §2.7).
  base['now'] = now;
  return base;
}

/**
 * Compute the derived facts that hold for a shaped snapshot at a fixed `now`.
 *
 * Pure function of `(snapshot, now, rules)`: no model call, no network, and the
 * **only** time input is the injected `now` (epoch ms). A predicate that
 * references a field absent from the snapshot evaluates to `false` (the fact
 * simply does not apply) rather than throwing, so one malformed item never
 * aborts a tick. Facts are returned in authored order.
 *
 * @param snapshot - The shaped snapshot (the source's raw facts).
 * @param now - The runtime-injected tick clock, in epoch milliseconds.
 * @param rules - The author-declared `shape.derive` rules, in order.
 * @returns The facts whose predicate held, in authored order.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.4
 */
export function computeDerivedFacts(
  snapshot: unknown,
  now: number,
  rules: readonly DerivedFactRule[],
): DerivedFact[] {
  const context = buildContext(snapshot, now);
  const facts: DerivedFact[] = [];
  for (const rule of rules) {
    let held: boolean;
    try {
      held = celEvaluate(rule.when, context) === true;
    } catch {
      // A predicate that references a field the snapshot does not carry (or
      // otherwise fails to evaluate) is treated as "fact does not hold" — a
      // deterministic, snapshot-only outcome, not a crash.
      held = false;
    }
    if (held) facts.push({ name: rule.name });
  }
  return facts;
}

/**
 * Render the shaped state (snapshot + the facts that hold) into a stable,
 * token-efficient, markdown-ish text artifact — **not** JSON. The same shaped
 * state MUST render to byte-identical text run-to-run: object keys are emitted
 * in a stable sorted order, facts in authored order, and there is no embedded
 * wall-clock. This artifact — not the raw source — is the Diff stage's input
 * (§1.1.5), so a newly-held fact surfaces as exactly one added line.
 *
 * @param snapshot - The shaped snapshot.
 * @param facts - The derived facts that held (authored order).
 * @returns The byte-stable rendered artifact.
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.5
 */
export function renderArtifact(
  snapshot: unknown,
  facts: readonly DerivedFact[],
): string {
  const lines: string[] = [];
  lines.push('# snapshot');
  for (const line of renderValueLines(snapshot)) lines.push(line);
  lines.push('# facts');
  // Facts are emitted one marker per line, in authored order, so a newly-held
  // fact is exactly one added line in the diff.
  for (const fact of facts) lines.push(`- ${fact.name}`);
  return lines.join('\n');
}

/**
 * Render an arbitrary JSON-ish value to stable, sorted, markdown-ish lines. Keys
 * are sorted lexicographically so reordering in the source produces no phantom
 * diff; arrays preserve index order (a meaningful signal).
 */
function renderValueLines(value: unknown, indent = 0): string[] {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return [`${pad}- (none)`];
  if (Array.isArray(value)) {
    const out: string[] = [];
    value.forEach((item, i) => {
      if (item !== null && typeof item === 'object') {
        out.push(`${pad}- [${String(i)}]`);
        out.push(...renderValueLines(item, indent + 1));
      } else {
        out.push(`${pad}- [${String(i)}] ${renderScalar(item)}`);
      }
    });
    return out;
  }
  if (typeof value === 'object') {
    const out: string[] = [];
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') {
        out.push(`${pad}- ${key}:`);
        out.push(...renderValueLines(child, indent + 1));
      } else {
        out.push(`${pad}- ${key}: ${renderScalar(child)}`);
      }
    }
    return out;
  }
  return [`${pad}- ${renderScalar(value)}`];
}

function renderScalar(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Validate a CEL predicate string at authoring time without evaluating it.
 * Returns `undefined` when the predicate parses, or a human-readable error
 * message when it does not. Used by `validate` so a malformed `shape.derive`
 * `when` predicate is rejected before runtime.
 *
 * @see ../../../../docs/specs/004-validation-testing.md §2.2
 */
export function validateCelPredicate(expression: string): string | undefined {
  const result = celParse(expression);
  if (result.isSuccess) return undefined;
  return result.errors.join('; ');
}
