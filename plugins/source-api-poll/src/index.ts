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

interface AuthConfig {
  type: 'bearer' | 'basic';
  'token-env'?: string;
  token?: string;
  username?: string;
  password?: string;
}

type ChangeStrategy = 'json-diff' | 'text-diff' | 'status-code';

interface ScopeConfig {
  url: string;
  auth: AuthConfig | undefined;
  headers: Record<string, string> | undefined;
  method: string | undefined;
  changeDetection: ChangeStrategy;
  /** Keyed-collection config (003 §12), present only under `strategy: json-diff`. */
  collection: KeyedCollectionConfig | undefined;
}

function parseScopeConfig(config: Record<string, unknown>): ScopeConfig {
  const url = config['url'];
  if (typeof url !== 'string') {
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

  return {
    url,
    auth: config['auth'] as AuthConfig | undefined,
    headers: config['headers'] as Record<string, string> | undefined,
    method: typeof config['method'] === 'string' ? config['method'] : undefined,
    changeDetection,
    collection,
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
                'Dotted $.-path to the array within the parsed JSON (e.g. "$.tasks")',
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
                'Dotted $.-paths (relative to each element) removed before comparison',
            },
          },
          required: ['path', 'key'],
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
  required: ['url'],
};

const source: ObservationSource = {
  name: 'api-poll',
  stateful: true,
  scopeSchema,

  async observe(
    config: Record<string, unknown>,
    context: ObservationContext = { now: new Date() },
  ): Promise<ObservationResult> {
    const { url, auth, headers, method, changeDetection, collection } =
      parseScopeConfig(config);
    const authHeaders = resolveAuth(auth);

    const response = await fetch(url, {
      method: method ?? 'GET',
      headers: { ...authHeaders, ...headers },
    });

    const body = await response.text();
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
        status: response.status,
        keyedSnapshot: result.snapshot,
      };
      return { observations: result.observations, nextState: curr };
    }

    const curr: CachedResponse = { body, status: response.status };

    if (prev !== undefined && hasChanged(changeDetection, prev, curr)) {
      return {
        observations: [
          {
            title: `API response changed: ${url}`,
            summary: `API response changed: ${url}`,
            payload: {
              url,
              status: response.status,
              strategy: changeDetection,
              body,
            },
            snapshotText: body,
            objectKey: url,
            queryScope: { url },
            snapshot: {
              url,
              status: response.status,
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
