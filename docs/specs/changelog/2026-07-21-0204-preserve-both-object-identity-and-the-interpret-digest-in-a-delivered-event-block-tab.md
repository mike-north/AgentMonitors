## 2026-07-21 — Preserve BOTH object identity and the Interpret digest in a delivered event block; TAB is an escaped control character in `events list --format text` (002 §1.1.6/§1.1.8, 005 §11.1, 006 §4.2.1) — Refs #449

Round-10 review follow-up to the 2026-07-20 `#449` entry below. The `objectDetail` fix in that
entry closed the object-identity loss, but selecting `objectDetail` alone for the rendered detail
line silently dropped a successful Interpret digest entirely — `buildEventBlock` (006 §4.2.1) now
renders an ADDITIONAL digest line (`DeliveryEventSummary.summary`) whenever it says something the
title, body, and `objectDetail` line do not, so a named multi-object `prose` monitor's delivered
block carries both which object changed and what the digest said about it. The common
no-digest-produced case is unaffected: `summary` then degrades to the same deterministic chain as
`objectDetail`, so the two are equal and the digest line is suppressed to avoid duplication. 006
§4.2.1 and the `buildEventBlock` TSDoc are updated to state the three-way suppression explicitly.

**`events list --format text`'s control-safe transform now also escapes TAB (U+0009).** It is a C0
control character like the others this transform escapes, and left raw it can still shift the
visual column layout of a row; the prior fix (2026-07-20 entry below) omitted it from the escaped
set. 005 §11.1 is updated to state the control-safe transformation and the `summary === body`
non-suppression explicitly (it previously claimed exact parity with `buildEventBlock`'s detail-line
suppression, which stopped being accurate once the digest line above was added and was already
inaccurate before that: `events list --format text` never renders `event.body`, so it has no reason
to suppress on a `summary === body` match the way the rendered block does).

**Two additional generated-artifact/report fixes, no behavior change to a runtime contract:**
`diffKeyedCollection`'s additive sixth parameter (`displayScope`, 2026-07-20 entry below) is now
reflected in the checked-in `libs/core/api-report/core.api.md`; and `generateMonitorSchema`'s
editor/authoring JSON Schema now adds a `pattern: "\\S"` constraint on `name` so it stays in parity
with `monitorFrontmatterSchema`'s whitespace-only rejection (2026-07-20 entry below) — previously
`agentmonitors schema generate`/editor validation accepted a `name: "   "` the authoritative parser
rejected at runtime.

