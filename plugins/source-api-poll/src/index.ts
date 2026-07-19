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
  displayObjectKey,
  parseKeyedCollectionConfig,
} from '@agentmonitors/core';

// Re-exported so API Extractor can resolve the default export's type — and
// the core types its interface shape transitively references — from this
// package's own entry point, instead of flagging ae-forgotten-export
// warnings in the checked-in API report.
export type {
  ChangeKind,
  JsonSchema,
  Observation,
  ObservationContext,
  ObservationResult,
  ObservationSource,
  Urgency,
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
  /**
   * The change-detection strategy as written by the author, or `undefined` when
   * the author omitted `change-detection.strategy`. The omitted case is resolved
   * after the fetch by inferring from the response `Content-Type` (003 §4.2,
   * issue #230); an explicit value always wins (no inference, no override).
   */
  explicitStrategy: ChangeStrategy | undefined;
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
  // `url` is optional only in composite mode (§2.6), which supplies per-part
  // URLs instead. But if it IS present it must be a string on ALL paths — a
  // non-string `url` alongside `composite` is a misconfiguration that would
  // otherwise be silently dropped.
  if (url !== undefined && typeof url !== 'string') {
    throw new Error('scope.url must be a string');
  }
  if (url === undefined && !composite) {
    throw new Error('scope.url must be a string');
  }

  // The strategy is honored *verbatim* when the author specifies one; when it is
  // OMITTED we leave `explicitStrategy` undefined and infer it from the response
  // Content-Type after the fetch (003 §4.2, issue #230). Explicit always wins.
  //
  // An unrecognized strategy value is an authoring error — not a signal to fall
  // through to inference. If the author wrote e.g. `strategy: jsondiff` (a
  // typo), silently inferring would violate "explicit always wins" and hide the
  // mistake. Throw immediately with a descriptive message so the author sees the
  // bad value, rather than observing unexpected behavior at runtime.
  const cd = config['change-detection'] as { strategy?: string } | undefined;
  const strategy = cd?.strategy;
  const knownStrategies: ChangeStrategy[] = [
    'json-diff',
    'text-diff',
    'status-code',
  ];
  if (
    strategy !== undefined &&
    !knownStrategies.includes(strategy as ChangeStrategy)
  ) {
    throw new Error(
      `unknown change-detection.strategy "${strategy}" (expected one of: json-diff, text-diff, status-code)`,
    );
  }
  const explicitStrategy: ChangeStrategy | undefined =
    strategy === 'status-code' ||
    strategy === 'json-diff' ||
    strategy === 'text-diff'
      ? strategy
      : undefined;

  // Keyed-collection mode (003 §12) is only valid under `json-diff`. The generated
  // schema rejects `collection` under other strategies at authoring time (BP3); this
  // is the defence-in-depth guard for the observe path. `collection` forces an
  // explicit `json-diff` (the schema's if/then requires it), so inference never
  // reaches the collection path.
  const collection = parseKeyedCollectionConfig(config['change-detection']);
  if (collection && explicitStrategy !== 'json-diff') {
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
    explicitStrategy,
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
): Promise<{ body: string; status: number; contentType: string | undefined }> {
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
  return {
    body: await response.text(),
    status: response.status,
    contentType: readContentType(response),
  };
}

/**
 * Read the `content-type` header from a fetch `Response`, tolerant of lightweight
 * test doubles that omit `headers`. The DOM/undici `Response` type declares
 * `headers` as always present, but a hand-built mock may not have it; reading
 * through `unknown` keeps this safe at runtime without lying to the type system.
 * A missing/empty header maps to `undefined` → text-diff inference (003 §4.2).
 */
function readContentType(response: Response): string | undefined {
  const headers = (response as { headers?: unknown }).headers;
  if (
    typeof headers === 'object' &&
    headers !== null &&
    typeof (headers as { get?: unknown }).get === 'function'
  ) {
    const value = (headers as Headers).get('content-type');
    return value ?? undefined;
  }
  return undefined;
}

/** Whether an HTTP status code is in the 2xx success range. */
function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Whether a `Content-Type` header indicates a JSON body: the `application/json`
 * media type or any structured-syntax `+json` suffix (e.g. `application/ld+json`,
 * `application/vnd.api+json`), per RFC 6838. Parameters (`; charset=utf-8`) and
 * case are ignored. Used to infer the change-detection strategy when the author
 * omits `change-detection.strategy` (003 §4.2, issue #230).
 *
 * @see https://www.rfc-editor.org/rfc/rfc6838#section-4.2.8 (+json suffix)
 */
function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  // Strip parameters (e.g. "; charset=utf-8") and normalize case/whitespace.
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

/**
 * Resolve the effective change-detection strategy. An explicit author value is
 * used verbatim (explicit always wins). When omitted, infer from the response
 * `Content-Type`: JSON media types → `json-diff`; everything else (text/html,
 * text/plain, missing/unknown) → `text-diff` (003 §4.2, issue #230).
 */
function resolveStrategy(
  explicit: ChangeStrategy | undefined,
  contentType: string | undefined,
): ChangeStrategy {
  if (explicit !== undefined) return explicit;
  return isJsonContentType(contentType) ? 'json-diff' : 'text-diff';
}

/**
 * Whether `body` parses as JSON. Used to warn when `strategy: json-diff` is
 * configured against a body that is not JSON (e.g. an HTML status page), which
 * would silently degrade to text comparison (003 §4.2, issue #219).
 */
function isParseableJson(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove URL components that commonly carry credentials or request-scoped
 * tokens before embedding a URL in a non-fatal warning. The source should still
 * fetch the author's exact URL; only diagnostic text gets the redacted form.
 */
function redactUrlForWarning(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // Parsing failed, so we cannot reliably locate the userinfo (`user:pass@`)
    // or query/fragment boundaries — best-effort regexes can miss a `user:pass@`
    // when there's no `scheme://` prefix. This helper now guards durably
    // persisted error messages (observation_history), so we must never risk
    // leaking a credential. Return a fixed safe placeholder instead.
    return '[unparseable url redacted]';
  }
}

/**
 * Warning text for `strategy: json-diff` against a non-JSON body (issue #219).
 * Exported-adjacent constant kept beside the source so the test asserts the same
 * message the author sees.
 */
function jsonDiffNonJsonWarning(url: string): string {
  return `api-poll: change-detection.strategy is json-diff but the response from ${redactUrlForWarning(url)} does not parse as JSON; falling back to text comparison. Use strategy: text-diff for HTML/plain-text pages.`;
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
  // Issue all underlying calls CONCURRENTLY (Promise.all) so latency is
  // bounded by the slowest part, not the sum of all parts. A failed part still
  // fails the whole observation: Promise.all rejects on any rejection, so
  // `nextState` never advances and the prior baseline is preserved (002 §3) —
  // we never silently emit a composite missing a part.
  const results = await Promise.all(
    composite.parts.map(async (part) => {
      const { body, status } = await fetchBody(
        part.url,
        method,
        combinedHeaders,
      );
      // ---- Non-2xx → errored observation (issue #220, composite parity) -------
      // A composite assembles its snapshot by body-diffing the rendered whole, so
      // a non-2xx part body (a 401/500 error page) must NOT be baselined into the
      // snapshot — that would make a misconfigured monitor look healthy and diff
      // error pages. Throwing here rejects the surrounding Promise.all, so
      // `nextState` never advances and the prior baseline is preserved (002 §3),
      // exactly as the single-URL path does. There is no `status-code` exemption
      // in composite mode: composite is always a body-diffing assembly, never a
      // status-transition watcher, so every part must be a 2xx success.
      if (!isSuccessStatus(status)) {
        throw new Error(
          `api-poll received HTTP ${String(status)} from composite part "${part.id}" (${redactUrlForWarning(part.url)}) — check auth/url; not establishing a baseline on an error response`,
        );
      }
      return { id: part.id, body } satisfies FetchedPart;
    }),
  );

  // Render ONCE: the same string drives both change-detection (nextState) and
  // the observation snapshotText, avoiding a second render on change.
  const rendered = renderCompositeSnapshot(results);
  const nextState: CompositeState = { composite: rendered };

  const prev = isCompositeState(previousState) ? previousState : undefined;
  // Baseline (first run) or unchanged composite: advance the cursor, emit
  // nothing. A change emits the current composite snapshot — never a diff.
  if (prev === undefined || prev.composite === rendered) {
    return { observations: [], nextState };
  }

  return {
    observations: [buildCompositeObservation(composite, results, rendered)],
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
      explicitStrategy,
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

    const { body, status, contentType } = await fetchBody(
      url,
      method,
      combinedHeaders,
    );

    // Resolve the effective strategy: explicit wins verbatim; otherwise infer
    // from the response Content-Type (003 §4.2, issue #230). Inference can only
    // produce a body-diffing strategy (json-diff / text-diff), never status-code.
    const changeDetection = resolveStrategy(explicitStrategy, contentType);

    // ---- Non-2xx → errored observation (issue #220) -----------------------------
    // Establishing a change-detection baseline on an error body (e.g. a 401 from a
    // missing/invalid bearer token, or a 500 error page) makes a misconfigured
    // monitor look like it "works": it would baseline on the error page and diff
    // error pages, with no signal that auth/url is broken. Throw so the runtime
    // records an `errored` observation (no baseline advance) and `monitor test`
    // surfaces the status, instead of silently baselining.
    //
    // EXCEPTION: `status-code` strategy is precisely about detecting status
    // transitions (e.g. an endpoint going 200 → 503), so for it a non-2xx is a
    // legitimate observed signal — the status IS the watched object — not an
    // error. Only body-diffing strategies (text-diff / json-diff) treat a non-2xx
    // as an error, because diffing an error body is meaningless.
    if (changeDetection !== 'status-code' && !isSuccessStatus(status)) {
      throw new Error(
        `api-poll received HTTP ${String(status)} from ${redactUrlForWarning(url)} — check auth/url; not establishing a baseline on an error response`,
      );
    }

    const prev =
      context.previousState &&
      typeof context.previousState === 'object' &&
      !Array.isArray(context.previousState)
        ? (context.previousState as CachedResponse)
        : undefined;

    // ---- json-diff on a non-JSON body → warning (issue #219, #230) --------------
    // `json-diff` silently degrades to text comparison when a body does not parse
    // as JSON (003 §4.2). That is the wrong strategy for HTML/plain-text pages and
    // is invisible by default. Surface a warning (non-fatal) so `monitor test`
    // tells the author to switch to text-diff, rather than diffing HTML as JSON.
    //
    // The warning fires ONLY for the EXPLICIT json-diff case (issue #230): an
    // inferred strategy never mismatches the body — inference picks json-diff only
    // for JSON Content-Types — so an inferred choice must never warn.
    const warnings: string[] =
      explicitStrategy === 'json-diff' && !collection && !isParseableJson(body)
        ? [jsonDiffNonJsonWarning(url)]
        : [];

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
    const warningFields = warnings.length > 0 ? { warnings } : {};

    if (prev !== undefined && hasChanged(changeDetection, prev, curr)) {
      return {
        observations: [
          {
            title: `API response changed: ${displayObjectKey(url)}`,
            summary: `API response changed: ${displayObjectKey(url)}`,
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
        ...warningFields,
      };
    }

    return {
      observations: [],
      nextState: curr,
      ...warningFields,
    };
  },
};

export default source;
