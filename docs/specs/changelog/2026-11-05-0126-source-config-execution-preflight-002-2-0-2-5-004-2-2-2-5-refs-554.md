## 2026-11-05 — Source-config execution preflight (002 §2.0/§2.5, 004 §2.2/§2.5) — Refs #554

Apply Mike's 2026-11-05 decision: schema-invalid configs stop observing, including
existing configs previously allowed to run. Use the accepted `validateWatchScope`
helper before tick scheduling/notify processing and continuous watcher startup.
Report skips visibly with the same diagnostics as validate/explain/doctor; retain
baseline and pending notify state across restart so a corrected config resumes.
Cover source effects, sibling progress, directory/ephemeral ticks, watcher startup,
and built CLI diagnostic parity. Correct 004 §5.1's stale partial-validation claim.

