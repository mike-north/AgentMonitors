## 2026-11-12 — Hold-acceptance refusals: title cap, total message, report after materialization (002 §4.7) — Refs #570

Tighten §4.7. The not-held message caps the title at 200 code points (the reason keeps 512) so the
start of the reason always survives the 512-code-point display cap in history and explain; the
stored row and JSON history keep the whole message. Building the message never
throws: an unreadable serializer reason becomes `unknown serialization error`. The refusal is
reported (tick `erroredObservations`, watcher `onError`) only after the state commit, the `errored`
row and the span's materialization, and a throwing callback is ignored, so a callback failure cannot
lose a debounce batch flushed in the same dispatch. State the remaining limit: the check does not
cover a non-deterministic accessor that serializes differently on a later read.

