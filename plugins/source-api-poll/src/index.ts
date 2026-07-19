import type {
  JsonSchema,
  KeyedCollectionConfig,
  KeyedSnapshot,
  ObservationContext,
  ObservationResult,
  ObservationSource,
} from '@agentmonitors/core';
import {
  OPERATION_TIMEOUT_PATTERN,
  diffKeyedCollection,
  parseKeyedCollectionConfig,
  parseOperationTimeoutMs,
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
  framedPartByteLength,
  MAX_COMPOSITE_PARTS,
  MAX_PART_ID_LENGTH,
  parseCompositeConfig,
  renderCompositeSnapshot,
} from './composite.js';
import { mapWithConcurrency } from './map-with-concurrency.js';

/**
 * Maximum response body size, in bytes, that `api-poll` will buffer (issue
 * #304). Enforced twice: as an early rejection against a trusted
 * `Content-Length` header (before any body bytes are read), and — because
 * `Content-Length` can be absent (chunked encoding) or simply wrong — as a
 * running count while streaming the body, which is the authority. Either path
 * aborts the request and errors the observation; no partial body is ever
 * baselined or persisted.
 */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum number of composite parts (§2.6) fetched concurrently within one
 * `observe()` call (issue #304). Without a cap, a composite with many parts
 * starts every request at once, multiplying the stalled-connection and
 * memory-pressure risk this issue exists to bound.
 */
const MAX_COMPOSITE_CONCURRENCY = 5;

/**
 * Maximum cumulative bytes across ALL fetched parts of one composite
 * observation (issue #304 review, second round). `MAX_RESPONSE_BYTES` bounds
 * each individual part's body, and `MAX_COMPOSITE_CONCURRENCY` bounds how
 * many parts are in flight at once — but neither bounds the *aggregate*: a
 * composite with many small parts (e.g. 12 parts x 1 MiB, each individually
 * well under the per-part cap) still assembles and baselines a
 * `snapshotText`/`nextState` many times larger than any single-URL monitor's
 * cap, persisted every tick. Reusing the same 10 MiB figure here bounds the
 * composite's aggregate footprint to the same order of magnitude as a
 * single-URL monitor's response, regardless of how many parts it has.
 *
 * Issue #304 review, third round: the running total this budgets is now
 * {@link framedPartByteLength} — each part's RENDERED `## <id>\n<body>`
 * section, matching `renderCompositeSnapshot` — not the raw response-body
 * length. A reviewer repro (100,000 empty-body parts; a single empty-body
 * part with an 11 MiB `id`) showed the prior body-only counter never
 * tripping while the assembled artifact still grew unbounded through
 * per-part id-framing overhead and sheer part count. `MAX_COMPOSITE_PARTS`
 * (composite.ts) additionally bounds the part count itself, which this byte
 * budget alone cannot: 100,000 empty-body parts sum to 0 raw body bytes
 * regardless of what is counted.
 */
const MAX_COMPOSITE_BYTES = MAX_RESPONSE_BYTES;

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
   * Request/body deadline in milliseconds (issue #304). Resolved via core's
   * shared `parseOperationTimeoutMs` (issue #304 review, findings 5 + 6, and
   * second-round findings on non-string values / leading zeros / timer
   * overflow): defaults to `DEFAULT_OPERATION_TIMEOUT_MS` when `timeout` is
   * genuinely omitted (`undefined`); a *present* non-string value (a number,
   * `null`, …) is rejected rather than silently defaulted; a present string
   * is parsed via `parseDuration`, so an invalid value throws the same
   * descriptive error as every other duration field in the codebase
   * (defence-in-depth alongside the schema `pattern`); a zero-length
   * (`"0s"`) or leading-zero (`"01s"`) value is rejected, matching the
   * schema `pattern`'s `[1-9]\d*` grammar; and a value exceeding Node's
   * 32-bit `setTimeout` max (`"25d"`) is rejected instead of silently
   * overflowing to a near-instant timer.
   */
  timeoutMs: number;
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

  const timeoutMs = parseOperationTimeoutMs(config['timeout']);

  return {
    url: typeof url === 'string' ? url : undefined,
    auth: config['auth'] as AuthConfig | undefined,
    headers: config['headers'] as Record<string, string> | undefined,
    method: typeof config['method'] === 'string' ? config['method'] : undefined,
    explicitStrategy,
    collection,
    composite,
    timeoutMs,
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
    timeout: {
      type: 'string',
      pattern: OPERATION_TIMEOUT_PATTERN,
      default: '30s',
      description:
        'Deadline for a single request, covering both the response headers and streaming the body to completion. In composite mode (change-detection.composite), the same deadline applies to each part. Default 30s; must be at least 1 unit (e.g. "1s") — a zero-length or leading-zero deadline (e.g. "0s", "01s") is rejected — and at most 2147483647ms (~24.8 days), the largest delay Node\'s setTimeout can schedule.',
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
              // Issue #304 review, third round: bounds request count,
              // rendered-artifact size, and worst-case tick duration
              // (003 §4.9) — see MAX_COMPOSITE_PARTS in composite.ts.
              maxItems: MAX_COMPOSITE_PARTS,
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    // Issue #304 review, third round: bounds the rendered
                    // composite artifact's per-part framing overhead — see
                    // MAX_PART_ID_LENGTH in composite.ts.
                    maxLength: MAX_PART_ID_LENGTH,
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

/** Whether `err` is a Web-standard `AbortError` (thrown by an aborted fetch/read). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Timeout error message shared by both the header fetch and the body read (issue #304). */
function timeoutMessage(url: string, timeoutMs: number): string {
  return `api-poll request to ${redactUrlForWarning(url)} timed out after ${String(timeoutMs)}ms`;
}

/** Oversize error message shared by the declared and streamed byte-cap checks (issue #304). */
function oversizeMessage(url: string, detail: string): string {
  return `api-poll response from ${redactUrlForWarning(url)} ${detail}, exceeding the ${String(MAX_RESPONSE_BYTES)}-byte cap`;
}

/**
 * Abort the in-flight request and, if its response body stream has not been
 * consumed, cancel it — releasing the underlying connection back to the pool
 * instead of leaving it open with an unconsumed body pending (issue #304
 * review, finding 1). Shared by every path that rejects a response before (or
 * partway through) reading its body, so all of them release the connection
 * the same way.
 */
async function abortAndReleaseBody(
  controller: AbortController,
  response: Response,
): Promise<void> {
  controller.abort();
  try {
    // `response.body` is `undefined` on the declared-Content-Length rejection
    // path for lightweight test doubles (and on any response with no body at
    // all); optional chaining is a no-op there. A real, already-locked stream
    // (mid-stream cancellation) can reject `cancel()` — that rejection is not
    // itself an error worth surfacing over the oversize/timeout error the
    // caller is already about to throw.
    await response.body?.cancel();
  } catch {
    // Best-effort release; see comment above.
  }
}

/**
 * Read a fetch `Response` body under the shared byte cap (issue #304).
 *
 * `Content-Length`, when present, is checked first as an early rejection — no
 * point streaming a body the server already told us is too large. But
 * `Content-Length` is not authoritative: it can be absent (chunked transfer
 * encoding) or simply wrong, so every chunk read from the body stream is
 * counted, and the running total is the actual authority. Either check aborts
 * the request AND releases the response body (issue #304 review, finding 1)
 * before throwing, so the caller never baselines or persists a
 * partial/oversized body and never leaks the connection.
 *
 * Test doubles that return a plain `{ text() }` mock without a streaming
 * `.body` fall back to `response.text()` unbounded — real `fetch` responses
 * always expose `.body` as a `ReadableStream`, so production traffic is
 * always bounded by the streamed count.
 */
async function readBoundedBody(
  response: Response,
  controller: AbortController,
  url: string,
  timeoutMs: number,
): Promise<string> {
  const declaredBytes = readContentLength(response);
  if (declaredBytes !== undefined && declaredBytes > MAX_RESPONSE_BYTES) {
    await abortAndReleaseBody(controller, response);
    throw new Error(
      oversizeMessage(
        url,
        `declares Content-Length ${String(declaredBytes)} bytes`,
      ),
    );
  }

  const body = response.body;
  if (!body) {
    return response.text();
  }

  // Node's global `ReadableStream` typings (no DOM lib in this project, see
  // tsconfig.base.json `lib: ["ES2022"]`) resolve `getReader().read()` to an
  // untyped result; annotate it explicitly rather than propagating `any`.
  // (`ReadableStreamReadResult` itself is only exported from the
  // `node:stream/web` module, not globally, so it is spelled out inline.)
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Identifies the streamed-oversize rejection thrown below by reference, so
  // the catch clause can tell it apart from an abort-driven read failure even
  // though the oversize path itself calls `controller.abort()` (to release
  // the connection) before throwing — without this, the `signal.aborted`
  // fallback added for finding 4 below would misclassify our OWN oversize
  // rejection as a timeout.
  let oversizeRejection: Error | undefined;
  try {
    for (;;) {
      const { done, value } = (await reader.read()) as {
        done: boolean;
        value: Uint8Array | undefined;
      };
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        controller.abort();
        oversizeRejection = new Error(
          oversizeMessage(url, `streamed ${String(total)} bytes`),
        );
        throw oversizeRejection;
      }
      chunks.push(value);
    }
  } catch (readErr) {
    if (readErr === oversizeRejection) throw readErr;
    // Issue #304 review, finding 4: under an HTTP/2 or socket-teardown race,
    // undici can reject a mid-body read with a raw `TypeError: terminated`
    // instead of the `AbortError` this source's own timer produces — the
    // `signal.aborted` fallback still classifies that race as the documented
    // "timed out" error rather than surfacing the raw undici error. Mirrors
    // `fetchBody`'s own `isAbortError(err) || controller.signal.aborted` check.
    if (isAbortError(readErr) || controller.signal.aborted) {
      throw new Error(timeoutMessage(url, timeoutMs), { cause: readErr });
    }
    throw readErr;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    'utf8',
  );
}

/** Options controlling one bounded `fetchBody` call (issue #304 review). */
interface FetchBodyOptions {
  /**
   * When `false`, skip reading the response body entirely (issue #304
   * review, finding 2): the `status-code` strategy never inspects the body —
   * the status transition IS the watched signal — so reading it at all is
   * both unnecessary and, for a large endpoint, exactly the wedge/memory risk
   * this issue exists to bound. The unconsumed body is released back to the
   * connection pool via `cancel()` rather than left dangling. Defaults to
   * `true` (every other strategy needs the body).
   */
  readBody?: boolean;
  /**
   * An external signal that also aborts this request when it fires (issue
   * #304 review, finding 3): `observeComposite` wires each part's fetch to
   * the composite batch's shared signal, so once ANY part fails the whole
   * batch is doomed and every other in-flight part is cancelled immediately
   * instead of running to its own full per-part deadline.
   */
  externalSignal?: AbortSignal;
}

/**
 * One HTTP fetch, bounded by a single request/body deadline (issue #304) and
 * the shared byte cap, with the §153-item-6 cause-preserving error wrapping
 * for network-level failures.
 */
async function fetchBody(
  url: string,
  method: string | undefined,
  combinedHeaders: Record<string, string>,
  timeoutMs: number,
  options: FetchBodyOptions = {},
): Promise<{ body: string; status: number; contentType: string | undefined }> {
  const { readBody = true, externalSignal } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = (): void => {
    controller.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    externalSignal.addEventListener('abort', onExternalAbort);
  }
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: method ?? 'GET',
        headers: combinedHeaders,
        signal: controller.signal,
      });
    } catch (fetchErr) {
      if (isAbortError(fetchErr) || controller.signal.aborted) {
        throw new Error(timeoutMessage(url, timeoutMs), { cause: fetchErr });
      }
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

    if (!readBody) {
      try {
        // Release the unconsumed body back to the connection pool without
        // reading it (issue #304 review, finding 2) — cheaper than a full
        // read, and exempts `status-code` monitors from the byte cap by
        // construction, since the body is never buffered at all.
        await response.body?.cancel();
      } catch {
        // Best-effort: cancelling an already-closed/errored stream is not
        // itself an error worth surfacing here.
      }
      return { body: '', status: response.status, contentType: undefined };
    }

    const body = await readBoundedBody(response, controller, url, timeoutMs);
    return {
      body,
      status: response.status,
      contentType: readContentType(response),
    };
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
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

/**
 * Read a trusted `Content-Length` from a fetch `Response`, in bytes, or
 * `undefined` if absent/unparseable — tolerant of lightweight test doubles
 * that omit `headers`, mirroring {@link readContentType}. Used only as an
 * early rejection for the byte cap (issue #304); the streamed count remains
 * the authority regardless of what this returns.
 */
function readContentLength(response: Response): number | undefined {
  const headers = (response as { headers?: unknown }).headers;
  if (
    typeof headers === 'object' &&
    headers !== null &&
    typeof (headers as { get?: unknown }).get === 'function'
  ) {
    const value = (headers as Headers).get('content-length');
    const parsed = value === null ? NaN : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
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
  timeoutMs: number,
): Promise<ObservationResult> {
  // Cumulative RENDERED-artifact byte budget across ALL parts (issue #304
  // review, second AND third round): `MAX_RESPONSE_BYTES` bounds each part's
  // body individually, but nothing previously bounded the SUM — a composite
  // with many small parts could still assemble/baseline a snapshot many
  // times the size of any single-URL monitor's response. `totalBytes` sums
  // each part's RENDERED framed section (see `framedPartByteLength`), not
  // its raw body, so id-framing overhead counts too (third round). Read-
  // modify-written only from inside each worker's callback below;
  // `mapWithConcurrency`'s workers run on the single JS event loop
  // turn-by-turn (never truly in parallel), so this plain counter needs no
  // lock.
  let totalBytes = 0;

  // Issue underlying calls CONCURRENTLY, up to MAX_COMPOSITE_CONCURRENCY at a
  // time (issue #304), so latency is bounded by the slowest *batch* rather
  // than the sum of all parts, without starting every request in an
  // arbitrarily large composite at once. A failed part still fails the whole
  // observation immediately, without waiting for other in-flight parts (issue
  // #304 review, finding 3): `mapWithConcurrency` races a dedicated failure
  // promise against the worker pool, and the shared `AbortSignal` it hands
  // each part (wired into `fetchBody` below as `externalSignal`) cancels
  // every other in-flight part the instant the batch is doomed, instead of
  // letting them run to their own full per-part deadline. Either way,
  // `nextState` never advances and the prior baseline is preserved (002 §3) —
  // we never silently emit a composite missing a part. Each part still gets
  // the same request/body deadline and byte cap as a single-URL monitor.
  const results = await mapWithConcurrency(
    composite.parts,
    MAX_COMPOSITE_CONCURRENCY,
    async (part, signal) => {
      const { body, status } = await fetchBody(
        part.url,
        method,
        combinedHeaders,
        timeoutMs,
        { externalSignal: signal },
      );
      // ---- Non-2xx → errored observation (issue #220, composite parity) -------
      // A composite assembles its snapshot by body-diffing the rendered whole, so
      // a non-2xx part body (a 401/500 error page) must NOT be baselined into the
      // snapshot — that would make a misconfigured monitor look healthy and diff
      // error pages. Throwing here fails the surrounding mapWithConcurrency call,
      // so `nextState` never advances and the prior baseline is preserved (002 §3),
      // exactly as the single-URL path does. There is no `status-code` exemption
      // in composite mode: composite is always a body-diffing assembly, never a
      // status-transition watcher, so every part must be a 2xx success.
      if (!isSuccessStatus(status)) {
        throw new Error(
          `api-poll received HTTP ${String(status)} from composite part "${part.id}" (${redactUrlForWarning(part.url)}) — check auth/url; not establishing a baseline on an error response`,
        );
      }

      // ---- Cumulative composite byte budget (issue #304 review, second AND
      // third round) ----
      // Checked AFTER each part's own per-part byte cap (readBoundedBody) has
      // already passed, so this is purely the aggregate-across-parts check.
      // Sums the RENDERED framed section (`## <id>\n<body>`, matching
      // `renderCompositeSnapshot`) rather than the raw body — the reviewer's
      // third-round repro (an empty-body part with an 11 MiB `id`) showed a
      // body-only counter never tripping while the artifact still grew
      // unbounded through id-framing overhead alone. Throwing here fails the
      // whole batch exactly like the non-2xx case above: `mapWithConcurrency`
      // aborts every other in-flight part via the shared signal instead of
      // letting them run to completion, and `nextState` never advances.
      const fetchedPart: FetchedPart = { id: part.id, body };
      totalBytes += framedPartByteLength(fetchedPart);
      if (totalBytes > MAX_COMPOSITE_BYTES) {
        throw new Error(
          `api-poll composite "${composite.objectKey}" exceeded the ${String(MAX_COMPOSITE_BYTES)}-byte cumulative rendered-artifact budget after part "${part.id}" (${String(totalBytes)} bytes across the composite's framed parts fetched so far) — reduce the number/size of parts or split into multiple monitors`,
        );
      }

      return fetchedPart;
    },
  );

  // Render ONCE: the same string drives both change-detection (nextState) and
  // the observation snapshotText, avoiding a second render on change.
  const rendered = renderCompositeSnapshot(results);

  // ---- Final cumulative byte budget check on the FULLY RENDERED artifact
  // (issue #304 review, fourth round) ----
  // The running `totalBytes` check above sums each part's OWN framed section
  // (`framedPartByteLength`) as it is fetched, but `renderCompositeSnapshot`
  // joins those sections with `\n\n` separators that the running total never
  // counted (a reviewer-measured 2-byte undercount on a 50-part fixture).
  // Checking `Buffer.byteLength(rendered)` here — the ACTUAL byte length of
  // the artifact that becomes `snapshotText`/`nextState` — closes that gap
  // regardless of part count or fetch order, rather than trying to predict
  // the separator count mid-loop (which depends on the final sort order, not
  // fetch-completion order). `nextState` never advances on this throw, so the
  // prior baseline is preserved (002 §3), exactly like the running check.
  const renderedBytes = Buffer.byteLength(rendered, 'utf8');
  if (renderedBytes > MAX_COMPOSITE_BYTES) {
    throw new Error(
      `api-poll composite "${composite.objectKey}" exceeded the ${String(MAX_COMPOSITE_BYTES)}-byte cumulative rendered-artifact budget (${String(renderedBytes)} bytes across the composite's ${String(results.length)} rendered parts including inter-part separators) — reduce the number/size of parts or split into multiple monitors`,
    );
  }

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
      timeoutMs,
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
        timeoutMs,
      );
    }

    // `url` is guaranteed present by parseScopeConfig outside composite mode.
    if (url === undefined) {
      throw new Error('scope.url must be a string');
    }

    // `status-code` never inspects the body — the status transition IS the
    // watched signal (003 §4.9's exemption also applies here: reading and
    // buffering a body the strategy will never look at is exactly the
    // wedge/memory risk this issue exists to bound). Skip reading it
    // entirely for that strategy (issue #304 review, finding 2) — cheaper,
    // and exempts `status-code` monitors from the response byte cap by
    // construction. This can only be decided here for an EXPLICIT
    // `status-code` value: an omitted strategy is inferred from the response
    // Content-Type below, and inference never produces `status-code`.
    const readBody = explicitStrategy !== 'status-code';
    const { body, status, contentType } = await fetchBody(
      url,
      method,
      combinedHeaders,
      timeoutMs,
      { readBody },
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
