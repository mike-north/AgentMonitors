## 2026-06-28 — `api-poll` infers change-detection strategy from `Content-Type` (003 §4.1, §4.2) — Refs #230

`change-detection.strategy` is now **optional** for `api-poll`. Builds on the #219/#220 robustness work.

- **003 §4.2 — new (Refs #230).** When `change-detection.strategy` is **omitted**, the source infers
  it from the response `Content-Type`: a JSON media type (`application/json` or any structured-syntax
  `+json` suffix, per RFC 6838) → `json-diff`; everything else (`text/html`, `text/plain`, a
  missing/unknown `Content-Type`) → `text-diff`. This makes the common "watch a web page" case
  zero-config. The previous omitted-path behavior was a static `text-diff` default; it is now this
  Content-Type inference.

- **Explicit always wins.** An explicitly configured `strategy` is used **verbatim** — no inference,
  no override (user specification is absolute). Explicit `json-diff` against an HTML page stays
  `json-diff`; explicit `text-diff` against a JSON body stays `text-diff`.

- **#219 warning narrowed.** The json-diff-on-non-JSON warning now fires **only** for the _explicit_
  `json-diff` case. An _inferred_ strategy never warns, because inference picks `json-diff` solely for
  JSON `Content-Type`s and so never mismatches the body.

- **003 §4.1 + scaffold + authoring docs.** The §4.1 example marks `change-detection` optional and
  adds a no-`change-detection` "watch a web page" example; the `api-poll` scaffold
  (`apps/cli/src/commands/init.ts`) and `apps/website/.../authoring-monitors.md` do the same.

- **No public-type change.** Inference is internal to the source; `ObservationResult` is unchanged.

- **Proof:** `plugins/source-api-poll/src/index.test.ts` (omitted + `application/json` → json-diff;
  omitted + `application/ld+json` → json-diff; omitted + `text/html` → text-diff; omitted + missing
  `Content-Type` → text-diff; inferred json-diff does not warn; explicit `json-diff` + `text/html` →
  json-diff honored AND warns; explicit `text-diff` + JSON body → text-diff honored).

