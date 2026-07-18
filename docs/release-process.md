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
publishable package that isn't added to `PACKAGE_DIRS` fails CI. Adding a
package to `PACKAGE_DIRS` also means registering its npm trusted-publisher
record (see "Authentication" below) — until that's done it publishes through
the `NODE_AUTH_TOKEN` fallback instead of OIDC.

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

## Authentication: npm trusted publishing (OIDC), with a token fallback

The publish step (`pnpm publish`, invoked by `pnpm release` inside
[`scripts/publish-release-packages.mjs`](../scripts/publish-release-packages.mjs))
authenticates to npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers/)
whenever it can, falling back to a long-lived token only when it can't:

1. The Release workflow's `id-token: write` permission lets GitHub issue the
   job a short-lived OIDC identity token.
2. pnpm `>=11.0.7` gives that OIDC exchange **precedence** over any
   configured static token: `pnpm publish` tries the OIDC exchange first and
   only falls back to a token if the exchange fails (no trusted-publisher
   record for that package, etc.). The pinned version (see
   `package.json#packageManager` for the exact value) is well past this
   floor. Provenance attestation is automatic under trusted publishing; no
   `--provenance` flag or `NPM_CONFIG_PROVENANCE` is needed.
   - A separate, unrelated pnpm bug ([pnpm/pnpm#11513](https://github.com/pnpm/pnpm/issues/11513),
     an unresolved `${NODE_AUTH_TOKEN}` placeholder breaking OIDC publish
     outright) was fixed in pnpm `v11.1.3` (via [pnpm/pnpm#11526](https://github.com/pnpm/pnpm/pull/11526)).
     The pinned version is well past `v11.1.3` too.
3. npm authorizes the OIDC exchange only if a **trusted publisher record**
   exists for the package that exactly matches this workflow's identity:

   | Field             | Value                                                             |
   | ----------------- | ----------------------------------------------------------------- |
   | Owner/repository  | `mike-north/AgentMonitors` (exact case)                           |
   | Workflow filename | `release.yml` (filename only)                                     |
   | Environment       | `npm-publish`                                                     |
   | Permissions       | `publish` (add `createPackage` too for a package's first release) |

   Every package in `PACKAGE_DIRS` needs its own record — trusted publishing
   is configured per package on npmjs.com, not per repository. This
   registration requires an authenticated human (browser + 2FA) and cannot be
   automated from CI; see the npm trusted-publishers docs linked above.
   `npm trust list <package> --json` reports a registered record's fields
   above as a `permissions` array (see "Verifying a trusted-publisher
   record" below).

### Transition: the `NODE_AUTH_TOKEN` fallback

The Release workflow still passes `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`
to the publish step. Because OIDC takes precedence whenever a
trusted-publisher record exists (point 2 above), this token is **unused**
for any package that already has one — it only matters for a package that
doesn't yet. The intended order of operations:

1. Register a trusted-publisher record for every package in `PACKAGE_DIRS`.
2. Verify each one actually publishes via OIDC with provenance attached (see
   "Verifying a trusted-publisher record" and "Post-canary hardening"
   below).
3. Only then remove `NODE_AUTH_TOKEN` from the workflow and revoke the
   `NPM_TOKEN` secret.

Until step 1 is complete for every package, a single release run can publish
some packages via OIDC (with provenance) and others via the token fallback
(without it) — this mixed mode is **expected and fine** during the
transition, not a bug. Recovery stays safe either way: the publisher is
sequential and idempotent (`releaseCandidates()` skips anything already on
the registry), so a run that fails partway through — regardless of which
auth path a given package used — reconciles cleanly on the next successful
main CI run.

### Verifying a trusted-publisher record

To confirm a package's trusted-publisher record is registered and matches
this workflow's identity:

```bash
npm exec --yes --package=npm@11.18.0 -- npm trust list <package-name> --json
```

Confirm the output shows:

- `file`: `release.yml`
- `repository`: `mike-north/AgentMonitors`
- `environment`: `npm-publish`
- `permissions` includes `publish` (and `createPackage` for a package that
  hasn't published its first version yet)

### Post-canary hardening

Once the **first** OIDC publish for a package succeeds, verify provenance
was actually attached before relying on it:

```bash
npm view <package-name> dist.attestations --json
```

Only after that verification should the long-lived token be retired:

1. Remove `NODE_AUTH_TOKEN` from [`.github/workflows/release.yml`](../.github/workflows/release.yml).
2. Restrict token-based publishing for the package on npmjs.com.
3. Revoke the granular `NPM_TOKEN` secret.

Until all three of these are done, the long-lived token remains live and
must not be forgotten — it's the only thing keeping releases green for
packages that don't have a trusted-publisher record registered yet.

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
