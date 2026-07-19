import type { Observation } from '@agentmonitors/core';

/**
 * Composite observation (003 §2.6).
 *
 * A source MAY assemble **one** `Observation` from **many** underlying calls,
 * reducing N requests into a single stable, deterministic whole-state snapshot
 * under **one** `objectKey`. This is the C40 motivating case: a source that must
 * call an external API once per entity to reconstruct a whole document issues N
 * calls within a single `observe()` and renders them into one ordered
 * `snapshotText`. The runtime then diffs that one composite snapshot against the
 * consumer's baseline exactly as it would a single-call snapshot (003 §2.5).
 *
 * @see docs/specs/003-source-plugins.md §2.6
 */

/** A single sub-resource that contributes to the composite whole. */
export interface CompositePart {
  /** Stable, author-meaningful identity for this part (e.g. an entity id). */
  id: string;
  /** URL fetched to obtain this part's current state. */
  url: string;
}

/**
 * Maximum number of `parts` entries a single `change-detection.composite`
 * block may declare (issue #304 review, third round). The per-part byte cap
 * and the composite cumulative byte budget bound *size*, but neither bounds
 * *count* — a composite with many empty-body parts (e.g. 100,000 parts, each
 * an empty body) sails past both budgets while still issuing 100,000
 * requests and building a composite artifact with one framed section per
 * part. Capping the part count directly bounds three things at once: the
 * number of requests `observeComposite` issues per tick, the size of the
 * rendered composite artifact (bounded below in bytes too, but the part
 * count is what makes that bound tractable to reason about), and — per 003
 * §4.9 — the worst-case tick duration, since with `MAX_COMPOSITE_CONCURRENCY`
 * workers the batch takes at most `ceil(parts / MAX_COMPOSITE_CONCURRENCY) *
 * timeoutMs`. Enforced both here (defense in depth — `tick()` does not call
 * `validateWatchScope()`, per 002 §2.2) and in the JSON Schema (`scopeSchema`
 * in `index.ts`, `maxItems`), so an authoring-time `agentmonitors validate`
 * catches it before a monitor is ever ticked.
 */
export const MAX_COMPOSITE_PARTS = 50;

/**
 * Maximum length, in characters, of a single composite part's `id` (issue
 * #304 review, third round). Without a bound, a single part with an
 * enormous `id` (e.g. an 11 MiB string) inflates the rendered composite
 * artifact — `renderCompositeSnapshot` frames every part with `## ${id}\n` —
 * without ever tripping the per-part response-body cap, since the id is
 * author-supplied config, not a fetched response body. Enforced both here
 * and in the JSON Schema (`maxLength`), mirroring `MAX_COMPOSITE_PARTS`.
 */
export const MAX_PART_ID_LENGTH = 256;

/** Author config for composite mode (the `change-detection.composite` block). */
export interface CompositeConfig {
  /**
   * Stable identity for the assembled whole. The composite carries **one**
   * `objectKey` (003 §2.6): the composite *is* the observed object, so there is
   * one key for the whole, not one per underlying call.
   */
  objectKey: string;
  /** The underlying sub-resources reduced into the one composite snapshot. */
  parts: CompositePart[];
  /** Human-readable title for the composite observation. */
  title?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the `change-detection.composite` block, or return `undefined` if the
 * monitor does not use composite mode. Throws on a structurally invalid block so
 * the misconfiguration surfaces rather than silently degrading.
 */
export function parseCompositeConfig(
  changeDetection: unknown,
): CompositeConfig | undefined {
  if (!isRecord(changeDetection)) return undefined;
  const raw = changeDetection['composite'];
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new Error('change-detection.composite must be an object');
  }

  const objectKey = raw['object-key'];
  if (typeof objectKey !== 'string' || objectKey.length === 0) {
    throw new Error(
      'change-detection.composite.object-key must be a non-empty string',
    );
  }

  const rawParts = raw['parts'];
  if (!Array.isArray(rawParts) || rawParts.length === 0) {
    throw new Error(
      'change-detection.composite.parts must be a non-empty array',
    );
  }
  // Issue #304 review, third round: bounds request count, rendered-artifact
  // size, and worst-case tick duration (see MAX_COMPOSITE_PARTS doc comment).
  // Defense in depth alongside the `scopeSchema` `maxItems` — `tick()` does
  // not call `validateWatchScope()` (002 §2.2), so a hand-edited MONITOR.md
  // that skipped `agentmonitors validate` still must not reach the runtime.
  if (rawParts.length > MAX_COMPOSITE_PARTS) {
    throw new Error(
      `change-detection.composite.parts must not exceed ${String(MAX_COMPOSITE_PARTS)} entries (got ${String(rawParts.length)})`,
    );
  }

  const parts: CompositePart[] = rawParts.map((part, index) => {
    if (!isRecord(part)) {
      throw new Error(
        `change-detection.composite.parts[${String(index)}] must be an object`,
      );
    }
    const id = part['id'];
    const url = part['url'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `change-detection.composite.parts[${String(index)}].id must be a non-empty string`,
      );
    }
    // Issue #304 review, third round: bounds the rendered composite
    // artifact's per-part framing overhead (see MAX_PART_ID_LENGTH doc
    // comment).
    if (id.length > MAX_PART_ID_LENGTH) {
      throw new Error(
        `change-detection.composite.parts[${String(index)}].id must not exceed ${String(MAX_PART_ID_LENGTH)} characters (got ${String(id.length)})`,
      );
    }
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(
        `change-detection.composite.parts[${String(index)}].url must be a non-empty string`,
      );
    }
    return { id, url };
  });

  const title = raw['title'];
  return {
    objectKey,
    parts,
    ...(typeof title === 'string' ? { title } : {}),
  };
}

/** One fetched part: its declared id and the body text returned by its call. */
export interface FetchedPart {
  id: string;
  body: string;
}

/**
 * Render the fetched parts into one **stable, deterministic** composite snapshot
 * text (003 §2.6). Determinism rules:
 *
 * - Parts are emitted **sorted by `id`**, so call-completion order (which is
 *   nondeterministic for concurrent fetches) never churns the snapshot.
 * - Each part is delimited by a stable header so the runtime's line diff
 *   attributes a change to the specific part that changed.
 *
 * The same underlying state assembled the same way renders identically
 * run-to-run, so the runtime's diff against the consumer baseline (§2.5) is
 * meaningful rather than churned by ordering or transient fields.
 */
/**
 * The per-part framed section text used by {@link renderCompositeSnapshot}.
 * Factored out so {@link framedPartByteLength} (the running composite
 * cumulative byte budget, issue #304 review, third round) sums the SAME
 * framing the final render produces, rather than a byte count that only
 * approximates it.
 */
function framedPartSection(part: FetchedPart): string {
  return `## ${part.id}\n${part.body}`;
}

export function renderCompositeSnapshot(parts: FetchedPart[]): string {
  const ordered = [...parts].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return ordered.map(framedPartSection).join('\n\n');
}

/**
 * Byte length of one part's framed section — the `## <id>\n<body>` header
 * plus body that {@link renderCompositeSnapshot} emits for it — as UTF-8
 * (issue #304 review, third round). The composite cumulative byte budget
 * (`MAX_COMPOSITE_BYTES` in `index.ts`) sums THIS, not the raw response-body
 * length: a part's contribution to the rendered composite artifact is its
 * id-framing overhead plus its body, and a reviewer-reported repro (an
 * empty-body part with an 11 MiB `id`) inflates the artifact entirely
 * through framing, with zero body bytes. Excludes the `\n\n` join
 * separators between sections — a few bytes per part, dwarfed by
 * `MAX_COMPOSITE_BYTES` and further bounded by `MAX_COMPOSITE_PARTS` — so
 * this is a slight undercount of the final artifact, never an overcount.
 */
export function framedPartByteLength(part: FetchedPart): number {
  return Buffer.byteLength(framedPartSection(part), 'utf8');
}

/**
 * Assemble a single composite `Observation` from the config and the
 * **already-rendered** snapshot text. Callers must render once via
 * {@link renderCompositeSnapshot} and pass the result here to avoid a second
 * render (fix 3: single render, shared between change-detection and the
 * observation). The observation carries **one** `objectKey` (the whole) and a
 * deterministic `snapshotText`; it is a current-state snapshot, never a
 * pre-diffed delta — the runtime computes the diff against the consumer
 * baseline (§2.5).
 */
export function buildCompositeObservation(
  config: CompositeConfig,
  parts: FetchedPart[],
  snapshotText: string,
): Observation {
  const title = config.title ?? `Composite snapshot: ${config.objectKey}`;
  return {
    title,
    summary: title,
    objectKey: config.objectKey,
    snapshotText,
    payload: {
      objectKey: config.objectKey,
      parts: [...parts]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((p) => ({ id: p.id })),
    },
    snapshot: {
      objectKey: config.objectKey,
      partCount: parts.length,
    },
    queryScope: { objectKey: config.objectKey },
  };
}
