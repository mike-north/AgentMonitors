/** JSON Schema type — a plain object describing a JSON Schema fragment. */
export type JsonSchema = Record<string, unknown>;

/** Data returned by an observation source when it detects a change or event. */
export interface Observation {
  /** Human-readable title for the inbox item */
  title: string;
  /** Optional body/description */
  body?: string;
  /** Point-in-time snapshot data captured at fire time */
  snapshot?: unknown;
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
  observe(config: Record<string, unknown>): Promise<Observation[]>;
  /** Optional continuous watch mode */
  watch?(config: Record<string, unknown>): AsyncIterable<Observation>;
}
