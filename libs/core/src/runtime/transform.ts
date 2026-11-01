/**
 * The deterministic **payload-transform** evaluator for `payload.form: structured`
 * (spec: pipeline/post-processing, [spec: pipeline/post-processing](../../../../openspec/specs/pipeline/post-processing/spec.md)).
 *
 * When a monitor declares `payload.form: structured`, the author supplies a
 * turnkey declarative transform over the **canonical JSON** form of the shaped
 * snapshot. Two non-overlapping languages:
 *
 * - **`jq` reshapes** — its output is the reshaped JSON delivered as the
 *   structured payload.
 * - **`cel` gates** — it evaluates to a boolean: `true` delivers the canonical
 *   (un-reshaped) shaped snapshot; `false` **suppresses delivery entirely** (a
 *   suppressed delivery is recorded, not silently dropped — that recording is
 *   the runtime's job, spec: pipeline/post-processing).
 *
 * **CSP / Workers safety.** Both evaluators are pure parser/interpreter
 * implementations that do **not** use the `Function` constructor or `eval`:
 * `cel-js` is Chevrotain-based; `jq-in-the-browser` is a PEG parser-combinator
 * with a fixed builtin table. This matches the repo-wide constraint that drove
 * `@cfworker/json-schema` over `ajv`. The transform is a constrained declarative
 * expression — **not** arbitrary user code.
 *
 * @see ../../../../openspec/specs/monitor/definition/spec.md (payload form)
 * @see ../../../../openspec/specs/pipeline/post-processing/spec.md
 */
import { evaluate as celEvaluate, parse as celParse } from 'cel-js';
import jqInTheBrowser from 'jq-in-the-browser';

/** The transform language for a `structured` payload. */
export type TransformLanguage = 'jq' | 'cel';

/**
 * An author-declared `payload.transform` block ([spec: monitor/definition](../../../../openspec/specs/monitor/definition/spec.md)).
 */
export interface PayloadTransform {
  /** `jq` (extraction/reshaping) or `cel` (boolean significance gate). */
  language: TransformLanguage;
  /** The transform expression, evaluated over the canonical JSON snapshot. */
  expression: string;
}

/**
 * The result of applying a `structured` payload transform to a canonical JSON
 * snapshot.
 *
 * - For `jq`: `delivered: true` with `value` = the reshaped JSON.
 * - For `cel`: a `true` gate yields `delivered: true` with `value` = the
 *   un-reshaped canonical snapshot; a `false` gate yields `delivered: false`
 *   with no value (the delivery is suppressed — and recorded as such upstream).
 */
export type TransformOutcome =
  | { delivered: true; value: unknown }
  | { delivered: false; value?: undefined };

/**
 * Apply a `structured` payload transform to the canonical JSON form of a shaped
 * snapshot. Deterministic and side-effect-free.
 *
 * @param canonical - The canonical JSON snapshot (a plain JSON value).
 * @param transform - The author-declared transform.
 * @returns The transform outcome (reshaped value, or a gate decision).
 * @throws if the expression is malformed (callers that need a soft failure
 *   should validate first with {@link validatePayloadTransform}).
 *
 * @see ../../../../openspec/specs/pipeline/post-processing/spec.md
 */
export function applyPayloadTransform(
  canonical: unknown,
  transform: PayloadTransform,
): TransformOutcome {
  if (transform.language === 'jq') {
    // jq reshapes: its output IS the structured payload.
    const run = jqInTheBrowser(transform.expression);
    return { delivered: true, value: run(canonical) };
  }
  // cel gates: a boolean. `true` delivers the canonical snapshot un-reshaped;
  // `false` suppresses the delivery entirely (spec: pipeline/post-processing).
  const context =
    canonical !== null &&
    typeof canonical === 'object' &&
    !Array.isArray(canonical)
      ? (canonical as Record<string, unknown>)
      : { value: canonical };
  const gate = celEvaluate(transform.expression, context);
  return gate === true
    ? { delivered: true, value: canonical }
    : { delivered: false };
}

/**
 * Validate a `payload.transform` expression at authoring time without evaluating
 * it against data. Returns `undefined` when the expression compiles, or a
 * human-readable error message when it is malformed. Used by `validate` so a
 * malformed `jq`/`cel` transform is rejected before runtime
 * ([spec: monitor/definition](../../../../openspec/specs/monitor/definition/spec.md)).
 *
 * @see ../../../../openspec/specs/monitor/validation/spec.md
 */
export function validatePayloadTransform(
  transform: PayloadTransform,
): string | undefined {
  if (transform.language === 'cel') {
    const result = celParse(transform.expression);
    return result.isSuccess ? undefined : result.errors.join('; ');
  }
  // jq compiles at construction time and throws on a malformed expression.
  try {
    jqInTheBrowser(transform.expression);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
