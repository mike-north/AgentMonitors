---
applyTo: '**/*.test.ts'
---

# Test Guidance

- Prefer behavior-oriented tests that model real daemon, CLI, adapter, and
  session flows.
- Test restart safety, session isolation, unread projection behavior,
  debounce/coalescing behavior, and recap semantics.
- Avoid sleep-heavy timing tests when explicit clock or state control is
  possible.
- Docker-backed tests are useful when they model a realistic home directory and
  installed-tool environment, but they should stay deterministic and narrowly
  scoped.
- If a change affects persistence or delivery policy, add coverage that would
  fail on regression across restart or replay scenarios.
