## 2026-11-14 — External JSON own descriptor fields and Headers domain (002 §16) — Refs #596

Require own descriptor fields so post-load Object.prototype properties cannot
admit accessors or run inherited hooks. Record and array accessors report
`Accessor or hidden property.`. Remove the Headers inspector: its presentation
object can invoke inherited header-name setters, and a thrown setter can look
like a missing brand. Headers joins the non-exhaustive examples outside the
plain-data domain; no detection result is promised after prototype replacement.

