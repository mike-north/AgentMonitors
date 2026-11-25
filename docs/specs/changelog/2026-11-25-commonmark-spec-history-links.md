## 2026-11-25 — Tokenize specification history destinations without rewriting examples (004 §6.0) — Refs #669

History assembly now uses CommonMark source positions to identify inline links and
images. Only destination base prefixes change; literal code, titles, delimiters,
escaping and line endings retain their recorded text. Navigation tests share the
recognizer and use decoded destinations. Reference-style definitions outside code
are rejected with inline-link guidance so independent records cannot change one
another's label resolution when combined.

