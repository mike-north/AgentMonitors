## 2026-07-20 — `OPERATION_TIMEOUT_PATTERN` now bounds each unit numerically, closing the last schema/parser `timeout` gap; `api-poll`'s composite `id`-length rejection no longer allocates (003 §4.1/§4.9) — Refs #304

Round-6 review follow-up. Two prior entries in this file (2026-07-19, "Composite cumulative byte
budget, `timeout` non-string/leading-zero/overflow validation" and "`api-poll` bounds request
duration...") describe the schema/parser gap this entry closes as "deliberate" and "documented" —
that framing was wrong: an author-visible authoring/runtime split (`agentmonitors validate` accepts
`timeout: "25d"`, `source.observe` then rejects it) is a parity bug regardless of how clearly it is
documented, not an acceptable design point. `OPERATION_TIMEOUT_PATTERN` previously used a raw
`[1-9]\d*` digit run per unit — a pure string grammar that could not express
`parseOperationTimeoutMs`'s `MAX_OPERATION_TIMEOUT_MS` numeric ceiling. The pattern is now built
from `Math.floor(MAX_OPERATION_TIMEOUT_MS / <unit's ms-per-unit>)` per unit (`2147483`s, `35791`m,
`596`h, `24`d) via a standard digit-range-to-regex construction, so the schema and the parser reject
exactly the same set of `timeout` values — `"25d"` now fails `agentmonitors validate` too, at
authoring time, instead of only at runtime. 003 §4.1 and §4.9 no longer cite the pattern's old
literal regex text (`^[1-9]\d*[smhd]$`), which is stale now that the pattern is unit-specific and
numerically bounded; they instead name `OPERATION_TIMEOUT_PATTERN` and state its derivation. See
`libs/core/src/notify/notifier.test.ts` for the per-unit boundary coverage (exact maximum accepted,
one more rejected, for all four units) and
`plugins/source-command-poll/src/schema-parity.test.ts` for the closed-gap parity case.

Separately, `plugins/source-api-poll/src/composite.ts`'s `MAX_PART_ID_LENGTH` check (added in the
2026-07-19 "Composite part-count/part-`id` caps" entry below) counted a part `id`'s Unicode code
points via `Array.from(id).length`, which materializes one array element per code point BEFORE the
length is even read — an 11 MiB `id` (the round-3 reviewer's own repro for _why_ the cap exists)
still allocated roughly its own size in memory just to be rejected, undermining the cap's own
purpose. It now counts via a plain `for...of` loop that returns as soon as the running count exceeds
`MAX_PART_ID_LENGTH`, making rejection O(`MAX_PART_ID_LENGTH`) instead of O(`id.length`).

The four `@agentmonitors/source-api-poll` Changesets accumulated across this issue's review rounds
(request/response bounds, composite byte budget, composite part/id bounds, and review-fix
follow-ups) are also consolidated into one, reclassified `minor` — the new `timeout` scope field is
additive authoring surface, matching this repository's precedent for the earlier `api-poll`
composite option.

