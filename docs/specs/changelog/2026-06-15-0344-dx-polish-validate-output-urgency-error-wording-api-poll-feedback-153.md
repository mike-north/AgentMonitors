## 2026-06-15 — DX polish: validate output, urgency error wording, api-poll feedback (#153)

Several author-facing DX improvements shipped as a cluster:

- **005 §3 (validate output consistency):** `validate` now displays the monitor ID (folder/stem
  name) for both valid and invalid monitors in text output, not the full file path for errors.
  Passing a file path to `validate` shows a `monitor test` pointer in the error. (Previously,
  invalid monitors printed the full absolute path; valid monitors printed the ID — inconsistent.)

- **core (urgency error wording):** The inverted-range error no longer repeats the field name.
  Before: `urgency: urgency range "high..normal" is inverted …`. After: `urgency: range
"high..normal" is inverted …`. (The Zod path prefix already includes `urgency:` as context.)

- **003 §4.6 (api-poll network error propagation):** Node `fetch` wraps real network errors
  (ECONNREFUSED, ENOTFOUND, …) as `err.cause`. The plugin now catches, extracts the cause
  message, and re-throws `"fetch failed: <cause>"` so `monitor explain` shows the real reason.

- **003 §4.7 (api-poll `monitor test` baseline output):** `monitor test` now prints the HTTP
  status code and UTF-8 response body size after the baseline for `api-poll` sources. This makes
  transport-level successes with unexpected responses (e.g. a 404 on a mistyped-but-resolvable URL,
  or an empty 200) immediately visible. Network-level failures (ECONNREFUSED, ENOTFOUND, …) are a
  separate case: they throw before a baseline exists and are surfaced via §4.6 error propagation
  (visible in `monitor explain`), not via the status/size line.

