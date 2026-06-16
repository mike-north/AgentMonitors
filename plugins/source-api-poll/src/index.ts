import type {
  JsonSchema,
  KeyedCollectionConfig,
  KeyedSnapshot,
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '@agentmonitors/core';
import {
  diffKeyedCollection,
  parseKeyedCollectionConfig,
} from '@agentmonitors/core';
import {
  buildCompositeObservation,
  type CompositeConfig,
  type FetchedPart,
  parseCompositeConfig,
  renderCompositeSnapshot,
} from './composite.js';

interface AuthConfig {
  type: 'bearer' | 'basic';
  'token-env'?: string;
  token?: string;
  username?: string;
  password?: string;
}

type ChangeStrategy = 'json-diff' | 'text-diff' | 'status-code';

interface ScopeConfig {
  url: string | undefined;
  auth: AuthConfig | undefined;
  headers: Record<string, string> | undefined;
  method: string | undefined;
  changeDetection: ChangeStrategy;
  /** Keyed-collection config (003 §12), present only under `strategy: json-diff`. */
  collection: KeyedCollectionConfig | undefined;
  /**
   * Composite-observation config (003 §2.6), present only when the monitor uses
   * `change-detection.composite`. Reduces N sub-resource calls into one stable
   * snapshot under one `objectKey`.
   */
  composite: CompositeConfig | undefined;
}

function parseScopeConfig(config: Record<string, unknown>): ScopeConfig {
  const composite = parseCompositeConfig(config['change-detection']);

  const url = config['url'];
  // In composite mode (003 §2.6) the whole is assembled from per-part URLs, so
  // a top-level `url` is not required; otherwise it is mandatory.
  if (typeof url !== 'string' && !composite) {
    throw new Error('scope.url must be a string');
  }

  const cd = config['change-detection'] as { strategy?: string } | undefined;
  const strategy = cd?.strategy;
  const changeDetection: ChangeStrategy =
    strategy === 'status-code' || strategy === 'json-diff'
      ? strategy
      : 'text-diff';

  // Keyed-collection mode (003 §12) is only valid under `json-diff`. The generated
  // schema rejects `collection` under other strategies at authoring time (BP3); this
  // is the defence-in-depth guard for the observe path.
  const collection = parseKeyedCollectionConfig(config['change-detection']);
  if (collection && changeDetection !== 'json-diff') {
    throw new Error('change-detection.collection requires strategy: json-diff');
  }

  // Composite (§2.6) assembles one whole from many calls; keyed-collection (§12)
  // tracks many independent objects. They are different shapes of fan-in and
  // cannot be combined on one monitor.
  if (composite && collection) {
    throw new Error(
      'change-detection.composite and change-detection.collection are mutually exclusive',
    );
  }

  return {
    url: typeof url === 'string' ? url : undefined,
    auth: config['auth'] as AuthConfig | undefined,
    headers: config['headers'] as Record<string, string> | undefined,
    method: typeof config['method'] === 'string' ? config['method'] : undefined,
    changeDetection,
    collection,
    composite,
  };
}

function resolveAuth(auth: AuthConfig | undefined): Record<string, string> {
  if (!auth) return {};

  if (auth.type === 'bearer') {
    const envVar = auth['token-env'];
    const token = auth.token ?? (envVar ? process.env[envVar] : undefined);
    if (!token) {
      throw new Error(
        `Bearer auth requires a token. ${envVar ? `Set the ${envVar} environment variable or add auth.token to your monitor's scope config.` : "Add auth.token or auth.token-env to your monitor's scope config."}`,
      );
    }
    return { Authorization: `Bearer ${token}` };
  }

  const username = auth.username ?? '';
  const password = auth.password ?? '';
  const encoded = Buffer.from(`${username}:${password}`).toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

interface CachedResponse {
  body: string;
  status: number;
  /**
   * The keyed-collection snapshot from the previous cycle (003 §12), present only
   * when the monitor uses `change-detection.collection`. Held alongside the raw body
   * so the per-object diff has a baseline to compare against.
   */
  keyedSnapshot?: KeyedSnapshot;
}

/** Recursively sort object keys for order-insensitive JSON comparison. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function hasChanged(
  strategy: ChangeStrategy,
  prev: CachedResponse,
  curr: CachedResponse,
): boolean {
  switch (strategy) {
    case 'status-code':
      return prev.status !== curr.status;
    case 'json-diff':
      try {
        const prevJson = JSON.stringify(sortKeys(JSON.parse(prev.body)));
        const currJson = JSON.stringify(sortKeys(JSON.parse(curr.body)));
        return prevJson !== currJson;
      } catch {
        // Fall back to text comparison if JSON parsing fails
        return prev.body !== curr.body;
      }
    case 'text-diff':
      return prev.body !== curr.body;
  }
}

const scopeSchema: JsonSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'URL to poll' },
    method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
    auth: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bearer', 'basic'] },
        'token-env': { type: 'string' },
        token: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
      },
    },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    interval: {
      type: 'string',
      pattern: '^\\d+[smhd]$',
      description:
        'Polling interval (e.g., "5m"). Used by the scheduling engine, not by this plugin directly.',
    },
    'change-detection': {
      type: 'object',
      properties: {
        strategy: {
          type: 'string',
          enum: ['json-diff', 'text-diff', 'status-code'],
        },
        // Keyed-collection mode (003 §12). The `collection` block is only valid
        // under `strategy: json-diff`; the `if/then` below enforces that at
        // authoring time (BP3).
        collection: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Dotted path to the array within the parsed JSON (e.g. "tasks" or "$.tasks")',
            },
            key: {
              type: 'string',
              description:
                'Field on each element used as the per-object identity',
            },
            'ignore-paths': {
              type: 'array',
              items: { type: 'string' },
              description:
                'Dotted paths (relative to each element, e.g. "fetchedAt" or "$.fetchedAt") removed before comparison',
            },
          },
          required: ['path', 'key'],
        },
        // Composite-observation mode (003 §2.6): reduce N sub-resource calls into
        // ONE stable snapshot under ONE object-key. The composite *is* the
        // observed object, so there is one key for the whole, not one per call.
        composite: {
          type: 'object',
          properties: {
            'object-key': {
              type: 'string',
              description:
                'Stable identity for the assembled whole (the composite is the observed object)',
            },
            title: {
              type: 'string',
              description: 'Human-readable title for the composite observation',
            },
            parts: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Stable identity for this part of the whole',
                  },
                  url: {
                    type: 'string',
                    description:
                      "URL fetched to obtain this part's current state",
                  },
                },
                required: ['id', 'url'],
              },
              description:
                'The sub-resources reduced into the one composite snapshot',
            },
          },
          required: ['object-key', 'parts'],
        },
      },
      // BP3: change-detection.collection requires strategy: json-diff. Under any
      // other strategy (or the defaulted text-diff), presence of `collection` is an
      // authoring-time error.
      if: { required: ['collection'] },
      then: {
        properties: { strategy: { const: 'json-diff' } },
        required: ['strategy'],
      },
    },
  },
  // A monitor MUST configure either a top-level `url` (single-resource modes) or
  // `change-detection.composite` (composite mode §2.6, which supplies per-part
  // URLs instead). `url` is therefore not globally required: this `anyOf`
  // enforces "one or the other" so a config with neither is still rejected.
  anyOf: [
    { required: ['url'] },
    {
      properties: {
        'change-detection': { required: ['composite'] },
      },
      required: ['change-detection'],
    },
  ],
};

/** One HTTP fetch, with the §153-item-6 cause-preserving error wrapping. */
async function fetchBody(
  url: string,
  method: string | undefined,
  combinedHeaders: Record<string, string>,
): Promise<{ body: string; status: number }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: method ?? 'GET',
      headers: combinedHeaders,
    });
  } catch (fetchErr) {
    // Node's undici/fetch wraps the real network failure (ECONNREFUSED,
    // ENOTFOUND, timeout …) as `err.cause`. The outer `err.message` is the
    // generic "fetch failed", which is unhelpful in `monitor explain` output.
    // Re-throw a new error that includes the real cause in the message so
    // callers — both `monitor test` and the runtime's observation-history
    // audit — see the underlying reason. Issue #153 (item 6).
    const causeMsg =
      fetchErr instanceof Error && fetchErr.cause instanceof Error
        ? fetchErr.cause.message
        : null;
    const baseMsg =
      fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    // Use fetchErr as the cause to satisfy the preserve-caught-error rule;
    // the full cause chain is reachable via err.cause.cause.
    throw new Error(causeMsg ? `${baseMsg}: ${causeMsg}` : baseMsg, {
      cause: fetchErr,
    });
  }
  return { body: await response.text(), status: response.status };
}

/** Source-owned change-detection state for composite mode (§2.6). */
interface CompositeState {
  /** The prior rendered composite snapshot, used to decide whether to emit. */
  composite: string;
}

function isCompositeState(value: unknown): value is CompositeState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { composite?: unknown }).composite === 'string'
  );
}

/**
 * Composite observe path (003 §2.6): issue **N** calls within one `observe()`,
 * reduce them into **one** deterministic snapshot under **one** `objectKey`, and
 * emit a single composite observation. The source's `nextState` holds only the
 * prior rendered composite (its own change-detection cursor); the runtime owns
 * the consumer-baseline diff (§2.5).
 */
async function observeComposite(
  composite: CompositeConfig,
  combinedHeaders: Record<string, string>,
  method: string | undefined,
  previousState: unknown,
): Promise<ObservationResult> {
  // Issue every underlying call. A failed part fails the whole observation:
  // fetchBody throws, so `nextState` never advances and the prior baseline is
  // preserved (002 §3) — we never silently emit a composite missing a part.
  const fetched: FetchedPart[] = [];
  for (const part of composite.parts) {
    const { body } = await fetchBody(part.url, method, combinedHeaders);
    fetched.push({ id: part.id, body });
  }

  const rendered = renderCompositeSnapshot(fetched);
  const nextState: CompositeState = { composite: rendered };

  const prev = isCompositeState(previousState) ? previousState : undefined;
  // Baseline (first run) or unchanged composite: advance the cursor, emit
  // nothing. A change emits the current composite snapshot — never a diff.
  if (prev === undefined || prev.composite === rendered) {
    return { observations: [], nextState };
  }

  return {
    observations: [buildCompositeObservation(composite, fetched)],
    nextState,
  };
}

const source: ObservationSource = {
  name: 'api-poll',
  stateful: true,
  scopeSchema,

  async observe(
    config: Record<string, unknown>,
    context: ObservationContext = { now: new Date() },
  ): Promise<ObservationResult> {
    const {
      url,
      auth,
      headers,
      method,
      changeDetection,
      collection,
      composite,
    } = parseScopeConfig(config);
    const authHeaders = resolveAuth(auth);
    const combinedHeaders = { ...authHeaders, ...headers };

    // ---- Composite mode (003 §2.6) ----------------------------------------------
    // Reduce N sub-resource calls into one stable snapshot under one objectKey.
    if (composite) {
      return observeComposite(
        composite,
        combinedHeaders,
        method,
        context.previousState,
      );
    }

    // `url` is guaranteed present by parseScopeConfig outside composite mode.
    if (url === undefined) {
      throw new Error('scope.url must be a string');
    }

    const { body, status } = await fetchBody(url, method, combinedHeaders);
    const prev =
      context.previousState &&
      typeof context.previousState === 'object' &&
      !Array.isArray(context.previousState)
        ? (context.previousState as CachedResponse)
        : undefined;

    // ---- Keyed-collection mode (003 §12) ----------------------------------------
    // Parse the body as JSON and diff per keyed object, instead of treating the
    // whole body as one blob. Per-object observations carry `<url>#<key>` ids.
    if (collection) {
      const result = diffKeyedCollection(
        JSON.parse(body),
        collection,
        url,
        prev?.keyedSnapshot,
        { payload: { url }, queryScope: { url } },
      );
      const curr: CachedResponse = {
        body,
        status: status,
        keyedSnapshot: result.snapshot,
      };
      return { observations: result.observations, nextState: curr };
    }

    const curr: CachedResponse = { body, status: status };

    if (prev !== undefined && hasChanged(changeDetection, prev, curr)) {
      return {
        observations: [
          {
            title: `API response changed: ${url}`,
            summary: `API response changed: ${url}`,
            payload: {
              url,
              status: status,
              strategy: changeDetection,
              body,
            },
            snapshotText: body,
            objectKey: url,
            queryScope: { url },
            snapshot: {
              url,
              status: status,
              bodyLength: body.length,
              strategy: changeDetection,
            },
          },
        ],
        nextState: curr,
      };
    }

    return {
      observations: [],
      nextState: curr,
    };
  },
};

export default source;
