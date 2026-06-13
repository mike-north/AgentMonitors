# Engineering Team Instructions

Conventions for the engineering fleet working this repo. The PM agent maintains this file;
`CLAUDE.md` covers the codebase itself — this covers how we work together. Keep both.

## Picking up work

1. **GitHub issues are the queue.** Before starting one: add the **`in progress`** label, and
   check you're not duplicating an open PR or another `in progress` issue covering the same
   ground.
2. **The issue's acceptance criteria are the contract.** They were written to be testable —
   implement against them, and say so explicitly in the PR ("acceptance criteria N covered by
   test X"). If a criterion is wrong or unachievable, comment on the issue _before_ building
   around it.
3. **Deadlines in titles are real.** An issue dated (e.g. "due 2026-06-18") outranks undated
   work. When in doubt about priority: dated items, then P1/table-stakes language, then file
   order.
4. **Do not implement issues labeled `needs-decision`.** Such an issue has an unresolved design
   choice (often a pending CEO voice session) — building it bakes in an answer that may be reverted.
   The queue is for decided work. If you believe a `needs-decision` issue is actually ready, comment
   asking the PM to resolve and unlabel it; don't build around it. (This is distinct from a normal
   open issue, which is greenlit.)
5. **Blocked or descoping?** Comment on the issue with what/why and remove the `in progress`
   label so the queue reflects reality. Never go silent on a claimed issue.

## Building

6. **Specs govern.** Consult the `docs/specs/` doc matching your task (map in `CLAUDE.md`).
   Behavior changes update the matching spec **in the same PR**, plus a
   `docs/specs/spec-changelog.md` entry. If a spec section moves from _target_ to _current_,
   add `verified:` references and retire the roadmap item per `docs/specs/roadmap.md`.
7. **Changesets:** required for any published-package behavior or public-type change
   (`@agentmonitors/*`); not for docs, specs, CI, or plugin-marketplace content. Never a
   `major` bump without an issue explicitly authorizing it.
   **New publishable package checklist:** it MUST ship with a `CHANGELOG.md` (minimal:
   `# <name>` / `## 0.0.0` / `- Initial release.`) — the changesets action crashes the
   release pipeline with ENOENT without one (this has broken releases twice) — plus an
   entry in `scripts/publish-release-packages.mjs` `PACKAGE_DIRS` and standard
   `publishConfig`.
8. **Tests at the right layer.** Bug fixes ship a regression test that fails pre-fix.
   Anything touching the daemon, CLI surface, or plugin wiring gets integration coverage
   (the existing harnesses in `apps/cli/src/commands/cli.integration.test.ts` are the
   pattern — including the no-orphan-daemon discipline). "Tests pass" with the production
   contract untested is this repo's signature bug class — test the real input contract
   (stdin payloads, hooks.json command strings), not a hand-built approximation.
9. **Quality gate before opening a PR:** `pnpm check` and the affected test suites green;
   api-extractor report regenerated if core's public surface changed; `pnpm check:aipm` if
   you touched `agent-plugins/`.

## PRs, review, and merging

10. **Reference issues with `Refs #N`, never `Closes #N`/`Fixes #N`** — unless the PR
    genuinely completes the issue's full acceptance criteria. GitHub parses closing keywords
    anywhere in the body and will close tracking issues out from under the queue.
11. **The PM agent reviews PRs.** Auto-merge on green CI is fine **unless a review with
    comments has landed** — then every comment gets a reply before merge: what you changed,
    or why you respectfully didn't (disagreement is fine; silence is not). Resolve threads
    you've addressed. A PR merged past unanswered review feedback creates follow-up debt
    someone else pays.
12. **Comment the PR link on the issue** when you open it; close the issue only when the
    change is merged and the acceptance criteria are demonstrably met.

## Hard rules

13. **Never touch Version PRs** (branch `changeset-release/main`, title "Release packages"):
    no CI kicks, no auto-merge, no "fixing" their blocked status. The blocked state is
    Mike's deliberate release gate — he merges them personally.
14. **Never flip repo visibility, publish packages locally, or add/modify repo secrets.**
    Releases happen only through the CI pipeline via Mike's Version-PR merge.
15. **No internal codenames/wave numbers in public-facing content** (published packages,
    the docs site, npm READMEs). Repo-internal docs and issues may reference them freely.

## Context that helps

- **Current campaign:** Wave 2 of the distribution strategy
  (`docs/product/distribution-strategy.md`) kicks off **2026-06-18** — ~15 external users
  start authoring monitors. Work that improves author-facing DX, error messages, and
  debuggability punches above its weight until then.
- **Review priorities** (also in `.github/copilot-instructions.md`): durable-state bugs,
  session-isolation errors, and event loss during debounce/compaction/batching/restart
  outrank style. Design your tests to attack those first.
