## Context

008 §7 defines the capability ladder by the guarantee each rung enforces, not by the OS facility
that implements it. The concrete per-platform inventory is deliberately unwritten.

## Decisions

- **Disclosure is a report, never a knob.** A user-facing reliability tier was rejected: it shifts
  a correctness decision onto the user and invites configurations that claim more than the machine
  can enforce. The daemon always picks the strongest available rung and reports what it got.
- **Rungs are defined by guarantee.** Defining rungs by named OS primitives was rejected because
  the same guarantee is implemented by different facilities per platform; the guarantee is what
  tests can assert behaviorally.
- **Optional components never gate install.** Requiring the strongest primitive's optional
  component was rejected because it would make a working install depend on an extra setup step;
  the fallback runs and the component is picked up automatically when present.

## Open Questions (deferred to #480's design work)

- The per-platform inventory: which OS facilities implement each rung on each supported platform,
  and each rung's probe. Per #480's acceptance criteria this inventory is recorded in the
  capability's spec (platform table) when it lands.
- Per-rung behavioral fixtures depend on that inventory (008 §12).
