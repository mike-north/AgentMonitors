---
'@agentmonitors/source-file-fingerprint': minor
---

Accept a single `globs` pattern as a bare string in `file-fingerprint` scope (003 §3)

The most common file-watching case — one file or one glob — can now be written as
`globs: notes.md` instead of `globs: ['notes.md']`. `globs` accepts either a string (a single
pattern) or an array of strings (multiple patterns, OR-ed together); the string form is normalized
to a one-element array internally. The scope schema validates both forms, and empty patterns (an
empty string, an empty array, or any blank entry) are rejected with a clear message. Backward
compatible — every existing array-form monitor is unchanged.
