import type {
  JsonSchema,
  Observation,
  ObservationSource,
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

  return {
    url,
    auth: config['auth'] as AuthConfig | undefined,
    headers: config['headers'] as Record<string, string> | undefined,
    method: typeof config['method'] === 'string' ? config['method'] : undefined,
    changeDetection,
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
}

/** Track previous responses keyed by full config identity. */
const previousResponses = new Map<string, CachedResponse>();

/** Derive a stable cache key from the full scope config. */
function cacheKey(config: Record<string, unknown>): string {
  return JSON.stringify(config);
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
      },
    },
  },
  required: ['url'],
};

const source: ObservationSource = {
  name: 'api-poll',
  stateful: true,
  scopeSchema,

  async observe(config: Record<string, unknown>): Promise<Observation[]> {
    const { url, auth, headers, method, changeDetection } =
      parseScopeConfig(config);
    const authHeaders = resolveAuth(auth);

    const response = await fetch(url, {
      method: method ?? 'GET',
      headers: { ...authHeaders, ...headers },
    });

    const body = await response.text();
    const key = cacheKey(config);
    const curr: CachedResponse = { body, status: response.status };
    const prev = previousResponses.get(key);

    if (prev !== undefined && hasChanged(changeDetection, prev, curr)) {
      previousResponses.set(key, curr);
      return [
        {
          title: `API response changed: ${url}`,
          snapshot: {
            url,
            status: response.status,
            bodyLength: body.length,
            strategy: changeDetection,
          },
        },
      ];
    }

    previousResponses.set(key, curr);
    return [];
  },
};

export default source;
