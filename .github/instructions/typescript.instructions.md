---
applyTo: "apps/**/*.ts,libs/**/*.ts,plugins/**/*.ts"
---

# TypeScript And Boundary Guidance

- Prefer named union types for small closed sets such as urgency, lifecycle
  events, and transport operation kinds.
- Prefer user-defined type guards over repeated inline structural checks.
- Use `satisfies` where it improves type safety without widening values.
- Use Zod for runtime validation at IPC, daemon protocol, and untrusted input
  boundaries instead of dangerous casts.
- Prefer optional properties over `null` unless storage, wire format, or SQL
  semantics require a three-state distinction.
- Keep public types stable and API Extractor friendly. Avoid leaking internal
  library implementation types through exported surfaces.
- Avoid mutable module-level state unless it is deliberate runtime process
  state. Prefer explicit service objects and injected dependencies.

When suggesting refactors, prefer clearer contracts and safer boundaries over
clever type-level abstractions.
