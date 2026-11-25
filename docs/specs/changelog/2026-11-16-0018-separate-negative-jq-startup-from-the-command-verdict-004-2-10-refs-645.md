## 2026-11-16 — Separate negative jq startup from the command verdict (004 §2.10) — Refs #645

The negative facility driver bounds startup independently in a setup hook, then starts
its unchanged five-second command/report allowance at the selected fake-jq phase.
Startup has a seven-second bound with a named elapsed-time failure, inside the existing
ten-second hook limit. The command test retains its seven-second bound and reserved
one-second owned cleanup. Slow launch/import work cannot spend either command window.
The real helper's one-second jq budget remains unchanged. Deterministic clock
regressions cover slow startup, unlimited startup, a restarted allowance and a missing
one-second verdict.

