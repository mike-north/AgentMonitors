## 2026-11-12 — Keep follow-up inspection IDs positional (005 §6, §15) — Refs #584

Every suggested `monitor explain` and `monitor history` command puts flags before `--` and the
monitor ID after it, matching the existing repair suggestions. A legal leading-hyphen ID now
survives verbatim execution of skip-success and unknown-outcome hints, and doctor hints for
attached drops, pending/terminal retries, orphan drops and orphan retained work. A shared internal
builder owns quoting and the option/ID boundary for inspection and repair suggestions; runtime
repair diagnostic text stays byte-identical. Nine shell-executed regressions verify the intended
retry or loss is inspected and remains intact.

