/**
 * The runtime wiring of the deterministic **Shape** stage (G15) over an
 * {@link Observation}. It bridges the author-declared `shape`/`payload`
 * frontmatter to the pure Shape primitives (`./shape.js`) and the payload
 * transform evaluator (`./transform.js`), producing the effective diff input
 * and delivered payload **before** the runtime's Diff stage.
 *
 * It runs on the **shared** side of the per-recipient seam, so the work here is
 * computed once per observation regardless of recipient count
 * ([002 §1.1.2](../../../../docs/specs/002-runtime-delivery.md#112-the-shared--per-recipient-seam)).
 *
 * @see ../../../../docs/specs/002-runtime-delivery.md §1.1.4–§1.1.6
 */
import type { PayloadConfig, ShapeConfig } from '../schema/monitor-schema.js';
import type { Observation } from '../observation/types.js';
import { renderShapeArtifact } from './diff.js';
import { applyPayloadTransform } from './transform.js';

/** The Shape/payload frontmatter that parameterizes the stage. */
export interface ShapeStageConfig {
  shape?: ShapeConfig | undefined;
  payload?: PayloadConfig | undefined;
}

/** The outcome of the Shape stage for one observation. */
export interface ShapedObservation {
  /**
   * `true` when a `payload.form: structured` CEL gate evaluated `false`: the
   * delivery is suppressed entirely (§1.1.6) and no event is materialized.
   */
  suppressed: boolean;
  /**
   * The text the runtime diffs and stores. When `shape.render: rendered` is
   * declared, this is the stable rendered artifact (§1.1.5); otherwise it is the
   * observation's own `snapshotText` (today's behavior — fully backward
   * compatible).
   */
  snapshotText?: string | undefined;
  /**
   * The structured payload to persist when `payload.form: structured` reshapes
   * the snapshot; `undefined` leaves the observation's own payload in place.
   */
  payload?: unknown;
}

/**
 * The shaped snapshot value the Shape stage operates over: the source's
 * structured `snapshot` when present, else its `snapshotText`. (A source
 * surfaces raw facts; the runtime derives — 003 §2.7.)
 */
function shapedSnapshot(observation: Observation): unknown {
  return observation.snapshot ?? observation.snapshotText ?? null;
}

/**
 * Apply the deterministic Shape stage to an observation at the injected `now`.
 *
 * - **Render** (`shape`): when `shape` is declared, render the shaped snapshot +
 *   the facts that hold at `now` into the stable artifact, and use **that** as
 *   the diff/storage text (§1.1.4–§1.1.5).
 * - **Payload form** (`payload`): for `form: structured`, evaluate the declared
 *   `jq`/`cel` transform over the canonical JSON snapshot — `jq` reshapes the
 *   delivered payload; a `cel` gate of `false` suppresses delivery (§1.1.6).
 *   `prose | artifact | rendered` are deterministic-floor forms that leave the
 *   payload untouched here.
 *
 * Pure over `(observation, now, config)`; the only time input is the injected
 * `now`.
 *
 * @param observation - The shared observation.
 * @param now - The runtime-injected tick clock (a `Date`).
 * @param config - The monitor's `shape`/`payload` frontmatter.
 */
export function shapeObservation(
  observation: Observation,
  now: Date,
  config: ShapeStageConfig,
): ShapedObservation {
  const result: ShapedObservation = {
    suppressed: false,
    snapshotText: observation.snapshotText,
  };

  // (a/b) Derived facts + render-then-diff: only when `shape` is declared. The
  // artifact becomes the diff input instead of the raw source.
  if (config.shape) {
    result.snapshotText = renderShapeArtifact(
      shapedSnapshot(observation),
      now.getTime(),
      config.shape.derive ?? [],
    );
  }

  // (c) Author-declared payload form: only `structured` runs a transform here.
  if (config.payload?.form === 'structured' && config.payload.transform) {
    const canonical = shapedSnapshot(observation);
    const outcome = applyPayloadTransform(canonical, config.payload.transform);
    if (!outcome.delivered) {
      result.suppressed = true;
      return result;
    }
    result.payload = outcome.value;
  }

  return result;
}
