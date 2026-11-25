## 2026-07-16 — Escape embedded quotes in `doctor`'s printed remediation; `--socket` row corrected for the `doctor.report` RPC (005 §15) — Refs #387

Two follow-on fixes to the `lead-session` remediation shipped below (#387).

- **Unrunnable command for a workspace path containing `'`.** The remediation embeds
  `JSON.stringify({ session_id, cwd: workspacePath })` between hard-coded shell single-quotes for the
  printed `echo '<payload>' | agentmonitors session start`. `JSON.stringify` never escapes an
  embedded `'` (it isn't special in JSON), so a workspace path containing one closes the shell's
  quote early, breaking the very command the fix exists to make copy-paste runnable. Fixed with a
  `shellSingleQuote` helper (`apps/cli/src/commands/doctor.ts`) applying the standard POSIX
  close-escape-reopen idiom (`'\''`) to the payload before interpolation.
- **Stale `--socket` row.** The flag table still described `--socket` as only a
  "daemon-reachability ping", predating the #382 fix (above) that made `doctor` call the real
  `doctor.report` RPC over that socket, falling back in-process only when unreachable. Corrected.

