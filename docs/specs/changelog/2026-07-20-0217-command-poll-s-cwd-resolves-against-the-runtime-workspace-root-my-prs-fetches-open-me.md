## 2026-07-20 — `command-poll`'s `cwd` resolves against the runtime workspace root; `my-prs` fetches open/merged/closed separately; the CI-crossing double-fire is characterized, not silently left undocumented (003 §3.1, §11.1, §11.9) — Refs #444, #446

Three further PR #446 review findings closed on top of the entries above, all against exact head
`66741b0`:

**A scaffolded preset's `cwd:` was bound to the checkout path `init` ran from** (finding 826) — the
prior entry's own "not addressed" list called this out as inherent to the design, but the real fix
turned out to be a small, well-precedented core change rather than a `cwd:` tradeoff: 003 §11.1 now
resolves an **omitted** `cwd` (and, for a relative `cwd`, its base) against the runtime workspace/config
root for a project monitor — the same base `file-fingerprint` already resolves a relative `cwd`/`globs`
against (§3.1) — instead of the daemon's own process working directory. `command-poll`'s `resolveCwd`
(`plugins/source-command-poll/src/index.ts`) implements this; `agentmonitors init` no longer seeds an
absolute `cwd:` into either preset at all (the `seedPresetCwd` scaffold-time mechanism is removed
outright), so a scaffolded `MONITOR.md` has no project-root-shaped state to go stale when the project is
relocated, cloned elsewhere, or shared to a teammate's checkout.

**`my-prs`'s `--state all --limit 60` could still evict an old, still-open PR** (finding 989) once
enough newer PRs (open or terminal) existed, silencing its later CI/review activity — the prior entry
left this open as "real design work." §11.9's "Field selection" section is now split into three
separate `gh pr list` calls (`--state open --limit 30`, `--state merged --limit 20`, `--state closed
--limit 20`), each with its own `--limit` so terminal history can never displace open coverage, unioned
by a `jq -sc 'add | unique_by(.number) | ...'` stage that now runs the `--jq` reduction as a pipeline
step over the fetch's raw stdout rather than as `gh`'s own `--jq` flag (the mechanism that makes a
multi-call fetch possible at all — `-s`/`--slurp` folds however many arrays the fetch printed back into
one). `pr-review`'s single-call fetch is unaffected in shape; both presets now share the same
fetch/reduce split in `ghPresetScript`.

**A CI failure crossing the `pr-review`/`my-prs` readiness partition still fires both monitors**
(discussion `r3615190027`): static membership disjointness (the prior "disjoint by construction" entry
below) does not imply glitch-free crossing — `pr-review` sees `[PR] -> []`, `my-prs` sees `[] -> [PR,
needs: ci-failing]`, and both independently-scheduled `command-poll` monitors fire once each in the same
tick, for the same real event. This is the same residual class §11.9 already documented for a PR
merging under a same-identity reviewer scope (one dismissible removal plus one actionable entry, not
issue #441's N-round-trip multiplier) — reachable only when a reviewer-scoping model does not exclude
the current user's own PRs from `pr-review` (the label-driven model, or an unscoped queue); it cannot
fire on your own PR under the default `review-requested:@me` scope at all, since GitHub forbids
requesting your own review. No cross-monitor coordination is added to suppress it: the two presets are
independently scheduled instances with no shared state by design, and issue #441's own preferred remedy
— not shipping redundant payloads — is exactly what "the two presets do not overlap" already does. §11.9
is updated to state this explicitly for the CI-failure case (previously only the merge case was
documented), and `apps/cli/src/commands/pr-alerting-presets.test.ts` gained a dual-monitor transition
regression that pins the exact `[PR]->[]` / `[]->[PR, needs: ci-failing]` shape so a future change that
makes this fire for a DIFFERENT, undocumented reason is still caught.

004 §3.6 is updated to reflect the three-call `my-prs` fetch and the `cwd` portability guarantee; 005 §2's
"Repository auto-scoping" paragraph is updated to match (no more `cwd:` in either scaffolded preset).

