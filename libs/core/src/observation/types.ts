/** JSON Schema type — a plain object describing a JSON Schema fragment. */
import type { Urgency } from '../schema/types.js';

export type JsonSchema = Record<string, unknown>;

/**
 * The lifecycle transition an observed object underwent — a source-agnostic
 * vocabulary every source can speak, so consumers reason about change uniformly:
 *
 * - `created` — a new object or member entered the monitor's scope. This covers
 *   both first-time discovery of an object and a new item appearing in a watched
 *   collection or feed. The object did not previously exist within the monitored
 *   set, regardless of whether it existed somewhere upstream.
 * - `modified` — the object changed while remaining in scope; it existed before
 *   and still exists, but its observed state differs.
 * - `deleted` — the object was **destroyed upstream**; its information is
 *   permanently lost (a file removed from disk, a pull request deleted from the
 *   host). The agent should react as if the data is gone.
 * - `descoped` — the object **still exists upstream** but has left the monitor's
 *   scope, so it is no longer observed; no information is lost. Examples: a file
 *   that no longer matches the monitored globs; a pull request that closed while
 *   the monitor watched only open PRs.
 *
 * `deleted` and `descoped` are deliberately distinct: a `deleted` object is gone;
 * a `descoped` object merely left the observed window. An agent reacts differently
 * to lost information than to an object that moved out of the watched set.
 */
export type ChangeKind = 'created' | 'modified' | 'deleted' | 'descoped';

/**
 * Data returned by an observation source when it detects a change or event.
 *
 * **Sources return current-state snapshots, not diffs (003 §2.5).** An
 * `Observation` describes *what the watched thing is now* — its `snapshotText`
 * and/or `snapshot` metadata capture the current state — never a pre-computed
 * "what changed for the consumer" delta. The runtime is the **sole producer of
 * the delivery diff**: it diffs each observation's `snapshotText` against the
 * consumer's stored baseline (002 §5.2). A source MUST NOT attempt to compute
 * "what is new for recipient X" — it does not hold any recipient's baseline, so
 * that is structurally the runtime's job. This split is what lets one shared
 * observation fan out to recipients with divergent baselines.
 *
 * A source still carries change-detection state via {@link ObservationResult.nextState}
 * (003 §2.4) — but only to decide *whether to emit at all* and to advance its
 * own cursor, never to produce the consumer-facing delta.
 *
 * A single `Observation` MAY be a **composite** assembled from many underlying
 * source calls reduced into one stable, deterministic snapshot under one
 * `objectKey` (003 §2.6) — the runtime sees and diffs it exactly as a
 * single-call snapshot.
 *
 * @see docs/specs/003-source-plugins.md §2.5
 * @see docs/specs/003-source-plugins.md §2.6
 * @see docs/specs/002-runtime-delivery.md §5.2
 */
export interface Observation {
  /** Human-readable title for the inbox item */
  title: string;
  /** Optional body/description */
  body?: string;
  /** Optional short summary for lightweight delivery surfaces */
  summary?: string;
  /** Raw source payload, preserved for later querying */
  payload?: unknown;
  /** Optional textual snapshot for diffing and timeline views */
  snapshotText?: string;
  /** Source-defined stable object identity, e.g. a PR number or document id */
  objectKey?: string;
  /** Source-defined query metadata used for read-time scoping */
  queryScope?: Record<string, string | string[]>;
  /**
   * The lifecycle transition this observation reports, if the source tracks one.
   * The runtime copies it into the materialized event's `queryScope.changeKind`,
   * so it is filterable without each source populating `queryScope` itself.
   */
  changeKind?: ChangeKind;
  /**
   * Optional source-classified **salience** for this observation — the source's
   * domain judgment of how interrupt-worthy *this specific* observation is
   * (PP3: a domain observation, not runtime reasoning). It is deliberately named
   * `salience`, not `urgency`: `urgency` stays the monitor-level policy knob
   * authored in `MONITOR.md`.
   *
   * The runtime resolves the *effective* urgency as
   * `clamp(salience ?? band.lo, band.lo, band.hi)`, where `band` is the
   * monitor's authored `urgency` range. So salience can escalate the effective
   * urgency only **within** the author's band; a salience outside the band is
   * clamped to the nearest bound. A monitor with a bare scalar `urgency` (the
   * degenerate band `x..x`) can never be escalated, preserving PP5 and full
   * backward compatibility.
   *
   * @see docs/specs/003-source-plugins.md §2.3
   * @see docs/specs/002-runtime-delivery.md §4.1
   */
  salience?: Urgency;
  /** Point-in-time snapshot metadata captured at fire time */
  snapshot?: unknown;
}

export interface ObservationContext {
  /** Persisted state from the previous observation cycle */
  previousState?: unknown;
  /** Timestamp supplied by the runtime */
  now: Date;
  /**
   * Abort signal for continuous `watch()` execution. The runtime aborts it to
   * tear a watcher down (daemon shutdown, monitor removal). A `watch()`
   * implementation **SHOULD** stop yielding and release resources when it fires.
   * Unused by one-shot `observe()`.
   */
  signal?: AbortSignal;
}

export interface ObservationResult {
  observations: Observation[];
  /**
   * Persisted state to use during the next observation cycle.
   *
   * This is the source's **own change-detection state** (file fingerprints, the
   * last API body, a last-seen commit SHA) — used only to decide *whether* to
   * emit and to advance the source's own cursor. It is **not** a per-recipient
   * baseline and is never the delivery diff: the runtime owns the consumer
   * baseline and is the sole diff producer (003 §2.5, 002 §5.2).
   */
  nextState?: unknown;
  /**
   * Optional diagnostic: a source sets this to signal that this cycle was a
   * graceful re-baseline (it advanced its persisted state to the current point
   * but could not compute a delta — e.g. a gc'd/force-pushed prior ref), as
   * opposed to a genuine "nothing changed". The runtime records it as a
   * `rebaselined` observation-history outcome instead of `no-change`. Omitted by
   * sources that don't distinguish this case.
   */
  outcome?: 'rebaselined';
}

/**
 * Contract that all observation source plugins must implement.
 *
 * Each plugin is a default export implementing this interface.
 */
export interface ObservationSource {
  /** Unique plugin name (kebab-case, matches `source` field in MONITOR.md) */
  readonly name: string;
  /** JSON Schema fragment describing this source's `scope` configuration */
  readonly scopeSchema: JsonSchema;
  /** Whether this source requires a baseline before detecting changes (default: false) */
  readonly stateful?: boolean;
  /** One-shot observation: check for changes and return any observations */
  observe(
    config: Record<string, unknown>,
    context: ObservationContext,
  ): Promise<ObservationResult>;
  /**
   * Optional continuous watch mode. A source that opts in yields observations as
   * they happen; the runtime drives it via `AgentMonitorRuntime.watchMonitors()`,
   * funnelling each yielded observation through the same notify dispatch, event
   * materialization, and session projection pipeline as `observe()`. The source
   * **SHOULD** stop yielding when `context.signal` aborts. `observe()` remains
   * required (it is the fallback for one-shot ticks, e.g. `daemon once`).
   */
  watch?(
    config: Record<string, unknown>,
    context: ObservationContext,
  ): AsyncIterable<Observation>;
}
