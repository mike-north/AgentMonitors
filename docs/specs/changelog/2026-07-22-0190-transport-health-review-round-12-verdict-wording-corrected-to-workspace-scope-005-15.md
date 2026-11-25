## 2026-07-22 — Transport-health review round 12: verdict wording corrected to workspace scope (005 §15) — Refs #425

The `doctor` verdict line said `delivery to THIS session → via {hook | channel | both | none}`, but
the computation it summarizes is workspace-wide — `doctor` has no per-session attribution, only the
transport registry and lead-session state for the whole workspace. A reader could take "THIS
session" literally and expect the verdict to reflect their own invoking session specifically, which
it never has. The verdict, its surrounding CLI-reference prose, and the getting-started skill doc now
say `delivery to active sessions in this workspace → via {hook | channel | both | none}`, matching
what the check actually answers. No logic, problem codes, or exit codes changed — wording only.

