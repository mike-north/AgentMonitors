## 2026-11-15 — Preserve musl precedence for every pathname character (003 §11.2; 008 §3.3) — Refs #640

Musl wildcard matching covers CR, U+2028 and U+2029 retained in mapped pathnames,
including alongside ordinary glibc evidence. These mappings refuse before native
loading. Positive glibc evidence still requires an exact basename, so appended
separators cannot establish glibc. Injected mapping regressions verify both rules.

