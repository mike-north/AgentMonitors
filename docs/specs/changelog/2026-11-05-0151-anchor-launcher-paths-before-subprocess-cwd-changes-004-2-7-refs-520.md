## 2026-11-05 — Anchor launcher paths before subprocess cwd changes (004 §2.7) — Refs #520

The package-manager resolver returns absolute launcher paths for both invoking entries and discovered installation candidates. Relative PATH and invoking entries retain their selected file identity when packing or installation changes the child working directory.

