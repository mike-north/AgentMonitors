## 2026-10-30 — Preserve empty snapshots and make commit-order proof observable (002 §5.2) — Refs #482

Empty snapshots now participate in shared and newly projected recipient diffs: removing all
content produces a deletion delta and the empty value remains the next baseline. The Interpret
commit-order regression test now observes through a separate SQLite connection and asserts outside
the adapter callback, where fallback handling cannot swallow a failed test assertion.

