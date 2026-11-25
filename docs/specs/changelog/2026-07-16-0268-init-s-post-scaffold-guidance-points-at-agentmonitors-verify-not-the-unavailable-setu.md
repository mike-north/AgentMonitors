## 2026-07-16 — `init`'s post-scaffold guidance points at `agentmonitors verify`, not the unavailable `setup-monitors` skill (005 §2) — Refs #408

`init`'s "Verify the monitor fires" summary (both the named `init <name>` scaffold path and the
bare-init `--yes` bootstrap path) previously named only the `setup-monitors` skill's "Verify It
Fires" section as the "full fire-and-deliver recipe" — a dead end for a no-plugin/no-docs CLI user,
who has no way to reach that skill. Blind usability evidence: the no-docs subject followed exactly
that pointer, found it unusable, and only discovered the real answer — `agentmonitors verify`
(merged in #403) — afterward, by scanning `--help`.

Fixed by pointing both paths at `agentmonitors verify <name> --dir <dir>` (with `--manual` appended
for any `--type` other than `file-fingerprint`, since `verify`'s auto-trigger today only fabricates a
change for `watch.globs`-based sources — 005 §16). The `setup-monitors` skill reference is kept, but
now clearly labeled as a Claude-Code-plugin-only supplement alongside `verify`, never the only
pointer.

