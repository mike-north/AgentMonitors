import type {
  JsonSchema,
  Observation,
  ObservationSource,
} from '@agentmonitors/core';

interface AuthConfig {
  type: 'bearer' | 'basic';
  'token-env'?: string;
  token?: string;
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
        `Bearer auth requires a token. Set ${envVar ?? 'auth.token'} in scope config.`,
      );
    }
    return { Authorization: `Bearer ${token}` };
  }

  return {};
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
        const prevJson = JSON.stringify(JSON.parse(prev.body));
        const currJson = JSON.stringify(JSON.parse(curr.body));
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
      },
    },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    interval: { type: 'string', pattern: '^\\d+[smhd]$' },
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
