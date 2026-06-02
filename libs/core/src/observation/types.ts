/** JSON Schema type — a plain object describing a JSON Schema fragment. */
export type JsonSchema = Record<string, unknown>;

/**
 * The lifecycle transition an observed object underwent — a source-agnostic
 * vocabulary every source can speak, so consumers reason about change uniformly:
 *
 * - `created` — the object newly appeared / entered the monitor's scope.
 * - `modified` — the object changed while remaining in scope.
 * - `deleted` — the object was destroyed upstream; **its information is lost**
 *   (a file removed from disk, a pull request deleted from the host).
 * - `descoped` — the object still exists upstream but has **left the monitor's
 *   scope**, so it is no longer observed; no information is lost (a file that no
 *   longer matches the globs, a pull request that closed while watching open PRs).
 *
 * `deleted` and `descoped` are deliberately distinct: an agent reacts differently
 * to lost information than to an object merely leaving the observed set.
 */
export type ChangeKind = 'created' | 'modified' | 'deleted' | 'descoped';

/** Data returned by an observation source when it detects a change or event. */
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
  /** Persisted state to use during the next observation cycle */
  nextState?: unknown;
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
