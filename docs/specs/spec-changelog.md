# Spec Changelog

Specification changes are recorded as individual Markdown files in [changelog/](./changelog/).
This index remains the stable link to that history.

To record a change, add one new file named `YYYY-MM-DD-descriptive-slug.md` in that directory.
Choose a distinct descriptive name; no shared file or sequence number needs editing. Start with:

    ## 2026-11-25 — Describe the contract change (004 §5) — Refs #669

    Explain the change and its validation. Include issue and section references in the
    heading when relevant; omit them when there are none. Subsections may use `###`.

Use a real calendar date and a nonempty title, and end the file with a newline.
The date and full title together must be unique. The heading records any referenced
issues and spec sections without adding references that were never specified.
Use inline Markdown links relative to the entry file, such as `../004-validation-testing.md`.
Assembly rebases file links to `docs/specs/`, retaining the original historical link text.
Inline links and images may use titles and angle-delimited destinations, such as
`[Contract](<../004-validation-testing.md> "Validation")`. Code examples remain literal.
Reference-style definitions outside code are rejected by both validation and assembly:
their labels would share a document-wide scope when independent entries are combined.
Use inline links and images instead.

Run `pnpm check:spec-changelog` to validate entries. Run `pnpm specs:changelog` to view
all entries, newest date first, with equal dates ordered by filename. The command writes
Markdown to stdout; for a local file with working relative links, use
`pnpm --silent specs:changelog > docs/specs/spec-history.generated.md`.
That generated view is ignored by Git and is never committed.
