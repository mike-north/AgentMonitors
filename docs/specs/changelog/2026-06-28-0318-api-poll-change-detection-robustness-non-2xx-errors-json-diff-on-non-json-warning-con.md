## 2026-06-28 — `api-poll` change-detection robustness: non-2xx errors, json-diff-on-non-JSON warning, content-type strategy steering (003 §4.2, §4.5, §4.8) — Refs #219, #220

Two related corrections to the `api-poll` source contract, plus authoring guidance.

- **003 §4.8 — new (Refs #220).** A non-2xx HTTP response is now an **errored** observation for the
  `text-diff`/`json-diff` strategies (the source throws a status-bearing error
  `api-poll received HTTP <status> from <url> — check auth/url; not establishing a baseline on an error response`),
  so the runtime records `errored`, `daemon once`/`run` report it, `monitor history`
  shows `errored`, and `monitor test` shows `Observation failed: …`. It no longer silently baselines
  on an error body, which previously masked broken auth/URL (a bad token produced `HTTP 401` yet the
  monitor "observed successfully"). 2xx responses baseline/diff exactly as before. **Exception:** the
  `status-code` strategy still treats a non-2xx as a legitimate observed signal (the status is the
  watched object), so it does not throw — preserving 200 → 5xx detection.

- **003 §4.2 — clarified (Refs #219).** The existing silent `json-diff` → text fallback now also
  emits a **non-fatal warning** (`ObservationResult.warnings`) when `strategy: json-diff` is
  configured against a body that does not parse as JSON. `agentmonitors monitor test` prints it so the
  author is steered to `text-diff` for HTML/plain pages instead of getting quietly wrong diffing. The
  observation outcome is unchanged (still the text fallback). The change-detection table and the
  `api-poll` scaffold (`apps/cli/src/commands/init.ts`) now state strategy-by-content-type inline:
  `text-diff` for HTML/plain pages, `json-diff` for JSON APIs.

- **New public type field.** `ObservationResult.warnings?: string[]` — non-fatal source diagnostics,
  surfaced by `monitor test`; does not mark the cycle errored.

- **Proof:** `plugins/source-api-poll/src/index.test.ts` (401/500 → errored, no baseline; 2xx →
  baseline ok; `status-code` non-2xx still observes; json-diff on non-JSON → warning; json-diff on
  JSON → no warning; text-diff non-JSON → no warning); `apps/cli/src/commands/cli.integration.test.ts`
  (`monitor test` surfaces the status-bearing error and the json-diff warning).
- Minor changeset: `@agentmonitors/source-api-poll` behavior change; patch: `@agentmonitors/core`
  (new optional `ObservationResult.warnings`), `@agentmonitors/cli` (`monitor test` warning output).

