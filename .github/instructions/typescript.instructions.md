---
applyTo: 'apps/**/*.ts,libs/**/*.ts,plugins/**/*.ts'
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
- When deriving filesystem paths, prefer `path.dirname` / `path.parse` over
  `split` / `slice().join()`. String-splitting on the separator mishandles
  Windows drive roots (`C:\`) and UNC paths: `segments.slice(0, n).join(sep)`
  can yield a non-absolute `'C:'` at a drive root. Let the `path` module own
  the platform-specific edge cases.
- Boundary-validation schemas must keep their Zod parser and JSON-Schema
  representation in parity — accepting and rejecting the same inputs. See
  `schema.instructions.md`.

When suggesting refactors, prefer clearer contracts and safer boundaries over
clever type-level abstractions.
