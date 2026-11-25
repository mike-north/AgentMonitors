## 2026-06-28 — `file-fingerprint` `globs` accepts a string or an array (003 §3)

Ergonomics: the single-file/single-glob case can now be written as `globs: notes.md` instead of
`globs: ['notes.md']`. [003 §3.1](../003-source-plugins.md) updated to state that `globs` accepts a
bare string (a single pattern) or an array of strings (OR-ed), with the string form normalized to a
one-element array. Empty patterns are rejected. Backward compatible. Part of the "simple cases feel
simple" authoring-ergonomics pass.

