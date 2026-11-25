## 2026-11-12 — Test suites own their filesystem roots (004 §2.13; Refs #611)

Require shared default HOME/XDG/temp isolation for all maintained package/script
suites and standalone install checks, with inherited storage/session overrides
removed and child environments preserved. Add a coordinator guard for changed real
installation files, including absent roots and small-file content hashes, plus
case/file/run/exit cleanup. Fixed socket fallback tests relocate their namespace
without changing production paths. Fake-installation subprocess regressions and
uncached full-suite installation hashes establish the validation obligation;
the attribution refinement above supersedes this entry's original unconditional
concurrent-writer failure rule.

