/** JSON Schema type — a plain object describing a JSON Schema fragment. */
export type JsonSchema = Record<string, unknown>;

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
  /** Point-in-time snapshot metadata captured at fire time */
  snapshot?: unknown;
}

export interface ObservationContext {
  /** Persisted state from the previous observation cycle */
  previousState?: unknown;
  /** Timestamp supplied by the runtime */
  now: Date;
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
  /** Optional continuous watch mode */
  watch?(
    config: Record<string, unknown>,
    context: ObservationContext,
  ): AsyncIterable<Observation>;
}
