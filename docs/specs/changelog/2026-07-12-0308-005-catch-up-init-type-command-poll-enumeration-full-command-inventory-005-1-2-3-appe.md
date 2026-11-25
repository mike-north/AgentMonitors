## 2026-07-12 — 005 catch-up: `init --type`, `command-poll` enumeration, full command inventory (005 §1, §2, §3, Appendix A) — Refs #265

005 had drifted behind the shipped CLI: it documented `init --source` (the real flag has been
`--type` since the source/scope → watch migration) and its bundled-source enumerations omitted
`command-poll`. Corrected by re-deriving every section from the built CLI's `--help` output and the
`apps/cli/src/commands/*.ts` sources rather than memory.

- **005 §1 — corrected.** "four bundled source packages" → five, adding
  `@agentmonitors/source-command-poll`. The `--version` note no longer hardcodes a literal (it drove
  stale immediately — the doc said `0.0.0` while the shipped CLI was already on `0.7.0`); it now
  states that `getVersion()` reads `package.json` at runtime.
- **005 §2 — corrected.** `init`'s flag table now documents `--type <type>` (not `--source`) with
  all five choices, matching `apps/cli/src/commands/init.ts`; added the missing `command-poll` row
  to the templates table.
- **005 §3 — corrected.** `validate --format json`'s documented shape was missing the `duplicateIds`
  field that `apps/cli/src/commands/validate.ts` has always emitted (same shape as `scan`'s
  `duplicateIds`).
- **005 Appendix A — corrected.** Added the missing `monitor explain` row (present in body prose,
  absent from the inventory table) and corrected `monitor history`'s transport to note its
  in-process no-daemon fallback, matching the already-documented behavior in §6 and matching the
  wording already used on the `daemon status` row.
- Full inventory pass against `apps/cli/src/index.ts` and every `apps/cli/src/commands/*.ts` file
  confirmed no other command/flag drift; the `source search|install|update|remove` placeholders were
  already correctly marked (§7.2–§7.5 headers and Appendix A `Placeholder / not implemented (NP3)`).

