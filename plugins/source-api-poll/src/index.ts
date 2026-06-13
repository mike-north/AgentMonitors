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

interface CursorConfig {
  initial: string | undefined;
  nextStatePath: string;
  placeholder: string;
}

interface ScopeConfig {
  url: string;
  objectKey: string;
  auth: AuthConfig | undefined;
  headers: Record<string, string> | undefined;
  method: string | undefined;
  changeDetection: ChangeStrategy;
  /** Caller-held cursor config (003 §13), if this poll source is delta-native. */
  cursor: CursorConfig | undefined;
  /** Keyed-collection config (003 §12), present only under `strategy: json-diff`. */
  collection: KeyedCollectionConfig | undefined;
}

function parseScopeConfig(
  config: Record<string, unknown>,
  previousCursor: string | undefined,
): ScopeConfig {
  const rawUrl = config['url'];
  if (typeof rawUrl !== 'string') {
    throw new Error('scope.url must be a string');
  }
  const cursor = parseCursorConfig(config['cursor']);
  const cursorValue =
    cursor === undefined ? undefined : (previousCursor ?? cursor.initial ?? '');
  const url =
    cursor === undefined
      ? rawUrl
      : rawUrl.replaceAll(cursor.placeholder, cursorValue ?? '');

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

  const rawHeaders = config['headers'] as Record<string, string> | undefined;
  const headers =
    cursor === undefined || rawHeaders === undefined
      ? rawHeaders
      : Object.fromEntries(
          Object.entries(rawHeaders).map(([key, value]) => [
            key,
            value.replaceAll(cursor.placeholder, cursorValue ?? ''),
          ]),
        );

  return {
    url,
    objectKey: rawUrl,
    auth: config['auth'] as AuthConfig | undefined,
    headers,
    method: typeof config['method'] === 'string' ? config['method'] : undefined,
    changeDetection,
    cursor,
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
  /** Persisted caller-held cursor rendered into the next request (003 §13). */
  cursor?: string;
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

function parseCursorConfig(value: unknown): CursorConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('cursor must be an object');
  }
  const cursor = value as Record<string, unknown>;
  const nextStatePath = cursor['next-state'];
  if (typeof nextStatePath !== 'string' || nextStatePath.length === 0) {
    throw new Error('cursor.next-state must be a non-empty string');
  }
  const initial = cursor['initial'];
  const placeholder = cursor['placeholder'];
  return {
    initial: typeof initial === 'string' ? initial : undefined,
    nextStatePath,
    placeholder: typeof placeholder === 'string' ? placeholder : '{{state}}',
  };
}

function normalizeCursorPath(path: string): string {
  if (path === '$' || path.startsWith('$.')) return path;
  return `$.${path}`;
}

function assertValidCursorPathSegment(path: string, segment: string): void {
  if (segment.length === 0) {
    throw new Error(`Invalid cursor path "${path}": empty path segment`);
  }
  if (/[.[\]*?]/.test(segment)) {
    throw new Error(
      `Invalid cursor path "${path}": unsupported path segment "${segment}"`,
    );
  }
}

function resolveCursorPath(root: unknown, path: string): unknown {
  const normalizedPath = normalizeCursorPath(path);
  if (normalizedPath === '$') return root;
  const segments = normalizedPath.slice(2).split('.');
  let current: unknown = root;
  for (const segment of segments) {
    assertValidCursorPathSegment(path, segment);
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function extractNextCursor(
  body: string,
  cursor: CursorConfig | undefined,
): string | undefined {
  if (cursor === undefined) return undefined;
  const value = resolveCursorPath(JSON.parse(body), cursor.nextStatePath);
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  throw new Error(
    `cursor.next-state path "${cursor.nextStatePath}" must resolve to a scalar value`,
  );
}

function removeCursorPath(value: unknown, path: string | undefined): unknown {
  if (path === undefined) return value;
  const cloned = structuredClone(value);
  const normalizedPath = normalizeCursorPath(path);
  if (normalizedPath === '$') return undefined;
  const segments = normalizedPath.slice(2).split('.');
  let current: unknown = cloned;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i] ?? '';
    assertValidCursorPathSegment(path, segment);
    if (current === null || typeof current !== 'object') return cloned;
    if (!Object.hasOwn(current, segment)) return cloned;
    current = (current as Record<string, unknown>)[segment];
  }
  const last = segments.at(-1) ?? '';
  assertValidCursorPathSegment(path, last);
  if (current !== null && typeof current === 'object') {
    Reflect.deleteProperty(current, last);
  }
  return cloned;
}

function hasChanged(
  strategy: ChangeStrategy,
  ignoredJsonPath: string | undefined,
  prev: CachedResponse,
  curr: CachedResponse,
): boolean {
  switch (strategy) {
    case 'status-code':
      return prev.status !== curr.status;
    case 'json-diff': {
      let prevParsed: unknown;
      let currParsed: unknown;
      try {
        prevParsed = JSON.parse(prev.body);
        currParsed = JSON.parse(curr.body);
      } catch {
        // Fall back to text comparison if JSON parsing fails
        return prev.body !== curr.body;
      }
      return (
        JSON.stringify(
          sortKeys(removeCursorPath(prevParsed, ignoredJsonPath)),
        ) !==
        JSON.stringify(sortKeys(removeCursorPath(currParsed, ignoredJsonPath)))
      );
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
    cursor: {
      type: 'object',
      properties: {
        initial: { type: 'string' },
        placeholder: { type: 'string', default: '{{state}}' },
        'next-state': {
          type: 'string',
          description:
            'Dotted path to the scalar cursor value in the parsed JSON response body',
        },
      },
      required: ['next-state'],
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
    const prev =
      context.previousState &&
      typeof context.previousState === 'object' &&
      !Array.isArray(context.previousState)
        ? (context.previousState as CachedResponse)
        : undefined;
    const {
      url,
      objectKey,
      auth,
      headers,
      method,
      changeDetection,
      cursor,
      collection,
    } = parseScopeConfig(config, prev?.cursor);
    const authHeaders = resolveAuth(auth);

    const response = await fetch(url, {
      method: method ?? 'GET',
      headers: { ...authHeaders, ...headers },
    });

    const body = await response.text();
    const nextCursor = extractNextCursor(body, cursor);

    // ---- Keyed-collection mode (003 §12) ----------------------------------------
    // Parse the body as JSON and diff per keyed object, instead of treating the
    // whole body as one blob. Per-object observations carry `<url>#<key>` ids.
    if (collection) {
      const result = diffKeyedCollection(
        JSON.parse(body),
        collection,
        objectKey,
        prev?.keyedSnapshot,
        { payload: { url }, queryScope: { url } },
      );
      const curr: CachedResponse = {
        body,
        status: response.status,
        ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
        keyedSnapshot: result.snapshot,
      };
      return { observations: result.observations, nextState: curr };
    }

    const curr: CachedResponse = {
      body,
      status: response.status,
      ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
    };

    if (
      prev !== undefined &&
      hasChanged(changeDetection, cursor?.nextStatePath, prev, curr)
    ) {
      return {
        observations: [
          {
            title: `API response changed: ${objectKey}`,
            summary: `API response changed: ${objectKey}`,
            payload: {
              url,
              status: response.status,
              strategy: changeDetection,
              body,
            },
            snapshotText: body,
            objectKey,
            queryScope: { url: objectKey },
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
