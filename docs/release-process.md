# Release process

How `@agentmonitors/*` packages get versioned and published, and how a failed
publish recovers. This documents the _actual_ behavior of
[`.github/workflows/release.yml`](../.github/workflows/release.yml) and
[`scripts/publish-release-packages.mjs`](../scripts/publish-release-packages.mjs).

## The single package inventory

`PACKAGE_DIRS` in
[`scripts/publish-release-packages.mjs`](../scripts/publish-release-packages.mjs)
is the **one authoritative list** of publishable packages. The publisher, the
release-work gate, the standalone-consumer coverage check, and the collateral
dry-run all derive from it — there is no second hand-maintained list to drift
out of sync. `scripts/release-gate.test.ts` asserts `PACKAGE_DIRS` still matches
the non-private packages actually present in the workspace, so a newly added
publishable package that isn't added to `PACKAGE_DIRS` fails CI.

## Normal flow

1. A PR that changes published behavior or public types includes a
   [changeset](https://github.com/changesets/changesets).
2. On merge to `main`, CI runs. When it succeeds, the **Release** workflow runs.
3. The **detect release work** gate decides whether there is anything to do
   (see below). When there are pending changesets, the
   [changesets action](https://github.com/changesets/action) opens or updates
   the **"Release packages"** Version PR (bumping versions and consuming the
   changeset files).
4. **Mike merges the Version PR** — this is a deliberate manual release gate;
   the fleet never touches it (see `ENG_TEAM_INSTRUCTIONS.md`).
5. Merging the Version PR lands the version bumps on `main` with no remaining
   changesets. The next successful main CI run triggers Release again; this time
   the gate sees unpublished current versions and the publisher publishes them.

## The release-work gate

`scripts/release-gate.mjs` (invoked by the workflow's "Detect release work"
step) reports `should-run=true` when **either**:

- there are pending changesets (`*.md` other than `README.md` in `.changeset/`)
  — run so the Version PR is created/updated; **or**
- at least one current workspace version is not yet on its registry — run so the
  publisher reconciles it.

The second arm is **registry-driven**, not git-diff-driven. It asks the registry
"is `name@version` already published?" for every package in `PACKAGE_DIRS`, using
the same `releaseCandidates()` selection the publisher uses. An already-published
version is never selected, so the gate is safe to evaluate on every push.

### Registry outages: default-closed on uncertainty

Because the gate runs on _every_ push to `main`, a naive "any `npm view` failure
means not-published" would make it **default-open during a registry outage**: a
5xx, rate-limit, or DNS failure would report every package as unpublished and
flip `should-run` true on unrelated pushes, driving repeated Release-job
failures. So the registry check (`classifyPublication()`) distinguishes two
failure modes:

- **Definitive not-published** — npm reports `code E404` (the name/version is
  genuinely absent). This is a real release candidate; the gate runs.
- **Indeterminate** — any other failure (registry 5xx, rate limit, DNS/network).
  The registry didn't answer, so we can't tell. The **gate treats it as
  published** (default-closed): it emits a warning naming the package and the
  error, and does _not_ trigger a release on uncertainty. Because the gate
  re-evaluates on every push and the publisher is idempotent, a
  genuinely-unpublished package self-heals on the next push once the registry is
  reachable again.

The **publisher** applies the same E404-vs-transient distinction but with the
opposite bias (`alreadyPublishedOrThrow()`): an indeterminate result **fails the
publish loudly** rather than silently skipping a package that might be
unpublished (or blindly republishing one that might already exist). Publishing
mutates the registry, so it demands certainty; the gate only decides whether to
_attempt_ work, so it errs toward not disturbing a quiet `main`.

### Why not a git diff of the version-bump commit

An earlier gate keyed off `git diff HEAD^..HEAD` of a hard-coded set of
`package.json` manifests. That had two failure modes, both fixed by the
registry-driven gate:

- The manifest set was hand-maintained and had drifted from `PACKAGE_DIRS`
  (it omitted `plugins/source-command-poll`), so a bump to only that package
  never triggered a release.
- After a **partial publish** (some packages published, some failed), any later
  unrelated commit to `main` moved `HEAD` off the version-bump commit, making the
  gate false. The still-unpublished packages could then never publish, even
  though the publisher itself is retry-safe.

## Idempotent reconciliation and retry

`publish-release-packages.mjs` is idempotent: `releaseCandidates()` filters out
any package whose current version already exists on its registry
(`alreadyPublished()`), and only the remaining candidates are published. This
means:

- Re-running the publisher never republishes an existing version.
- If a publish partially fails, **no manual intervention is required**: the next
  successful main CI run re-evaluates the gate, finds the still-unpublished
  versions, and publishes exactly those. A merged Version PR therefore cannot
  leave packages permanently unpublished.

To force a reconciliation attempt without a new commit, re-run the CI workflow on
`main` (`workflow_dispatch`); its success re-triggers the Release workflow.

## Authentication: npm trusted publishing (OIDC)

The publish step (`pnpm publish`, invoked by `pnpm release` inside
[`scripts/publish-release-packages.mjs`](../scripts/publish-release-packages.mjs))
authenticates to npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers/),
not a long-lived token:

1. The Release workflow's `id-token: write` permission lets GitHub issue the
   job a short-lived OIDC identity token.
2. `pnpm publish` (pinned `packageManager` version `pnpm@11.12.0`, well past
   the `>=11.0.9` fix for [pnpm/pnpm#11513](https://github.com/pnpm/pnpm/issues/11513))
   exchanges that OIDC token for a short-lived npm publish token — no
   `NODE_AUTH_TOKEN`/`NPM_TOKEN` is passed to the publish step. Provenance
   attestation is automatic under trusted publishing; no `--provenance` flag
   or `NPM_CONFIG_PROVENANCE` is needed.
3. npm authorizes the exchange only if a **trusted publisher record** exists
   for the package that exactly matches this workflow's identity:

   | Field             | Value                                   |
   | ----------------- | --------------------------------------- |
   | Owner/repository  | `mike-north/AgentMonitors` (exact case) |
   | Workflow filename | `release.yml` (filename only)           |
   | Environment       | `npm-publish`                           |
   | Allowed action    | `publish`                               |

   Every package in `PACKAGE_DIRS` needs its own record — trusted publishing
   is configured per package on npmjs.com, not per repository. This
   registration requires an authenticated human (browser + 2FA) and cannot be
   automated from CI; see the npm trusted-publishers docs linked above.

Trusted publishing requires the source repository to be public — this
repository is. Read-only registry checks elsewhere in the pipeline (the
release-work gate's and publisher's `npm view` calls, and CI's
`publish:packages:dry-run`) don't need authentication at all and are
unaffected by this.

## Pre-release safety checks (on PRs)

CI runs these before anything can reach the release path:

- `pnpm test:scripts` — unit tests for the gate, collateral validation, and
  inventory drift guards.
- `pnpm publish:packages:dry-run` (CI's `publish-dry-run` job, after a build) —
  validates release collateral (`CHANGELOG.md`, `publishConfig`, a built entry
  point `npm pack` would include, `engines.node`/`repository`/`bugs`/`homepage`
  metadata, `README.md`/`LICENSE`) using `npm pack --dry-run` and unauthenticated
  `npm view` only — no registry writes.
- `pnpm test:standalone-consumer` — installs the built packages as an external
  consumer would and exercises every bundled source.
