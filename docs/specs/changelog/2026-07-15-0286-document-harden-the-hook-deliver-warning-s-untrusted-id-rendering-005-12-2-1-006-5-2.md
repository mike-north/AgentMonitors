## 2026-07-15 — Document + harden the hook-deliver warning's untrusted-id rendering (005 §12.2.1, 006 §5.2.1) — Refs #329

The always-on unknown-session stderr warning (issue #329) renders an id taken from untrusted
stdin. Two follow-ups from a post-merge review:

- **005 §12.2.1 / 006 §5.2.1 — clarified (current).** Both sections now state the rendering
  contract the implementation applies: the id is JSON-string-escaped (control characters never
  reach the terminal raw) and truncated at 128 characters with a trailing `…` — matching how the
  same specs document the analogous `additionalContext` truncation contract with precision.
- **Not a contract change — CLI hardening:** the truncation now cuts at a Unicode code-point
  boundary (a raw `slice` could split a surrogate pair straddling the cap, leaving a lone
  surrogate rendered as a garbled escape), following the same rationale as `hook deliver`'s
  render-side `truncateForCap`. The escaping also covers what `JSON.stringify` alone leaves
  raw — DEL, the C1 controls (U+0080–U+009F, e.g. CSI), and the U+2028/U+2029 line/paragraph
  separators — so the "control-safe one line" wording holds for the full range, matching the
  C0/C1 handling in the render-side `sanitize`.

