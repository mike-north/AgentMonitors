## 2026-11-12 — Refuse pre-existing deferred writers during ingress (004 §3.4.2) — Refs #568

Writable iterators are wrapped at creation regardless of lifecycle ownership.
Their supported advance/finalization methods refuse execution inside tick/watch
lifecycles with SQL and call-site evidence, including iterators created earlier.
Regressions verify both lifecycle boundaries, durable absence of the refused row,
continued in-lifecycle creation refusal, admitted read iterators and native writable
execution outside ownership. Published runtime behavior is unchanged.

