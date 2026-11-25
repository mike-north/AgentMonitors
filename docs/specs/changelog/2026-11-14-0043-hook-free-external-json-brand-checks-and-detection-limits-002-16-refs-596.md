## 2026-11-14 — Hook-free external JSON brand checks and detection limits (002 §16) — Refs #596

Remove property-reading crypto predicates and refuse real keys by their own symbols.
Establish proxy refusal and exact prototypes before captured read-only intrinsic
checks. Refuse prototype-replaced weak references, finalization registries, URLs,
query parameters and the supported Intl families without changing receiver state.
Document that callers must exclude prototype-replaced array/string iterators and
Headers because the available checks advance state or depend on prototype identity.

