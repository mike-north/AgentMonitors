---
name: Spec & standard changes from upstream
source: incoming-changes
urgency: normal
scope:
  paths:
    - 'docs/specs/**'
    - 'docs/standard/**'
  branch: main
  interval: 5m
---

When this monitor fires, a `git pull` (or local commit) has advanced `main` in a way that
touched the spec or standard documentation under `docs/specs/` or `docs/standard/`. Summarize
what changed: which spec sections were modified, added, or removed, and the intent of those
changes based on commit messages and diff content. Then assess whether any of the changes
affect the work currently in progress in this session — for example, if a spec section you
are implementing was revised, or if a new invariant was introduced that constrains your
design. Conclude with a short list of action items if the changes are relevant, or a brief
confirmation that the current work is unaffected.
