## 2026-06-09 — Package scope rename: `@mike-north/*` → `@agentmonitors/*`; public npm publish

All published packages now use the `@agentmonitors` npm scope published to public npm
(`https://registry.npmjs.org`), replacing the previous `@mike-north` GitHub Packages scope.
The CLI (`@agentmonitors/cli`) is now a publishable package (no longer `private: true`); the
canonical install is `npm install -g @agentmonitors/cli`.

Packages renamed:

- `@mike-north/core` → `@agentmonitors/core`
- `@mike-north/source-file-fingerprint` → `@agentmonitors/source-file-fingerprint`
- `@mike-north/source-api-poll` → `@agentmonitors/source-api-poll`
- `@mike-north/source-schedule` → `@agentmonitors/source-schedule`
- `@mike-north/source-incoming-changes` → `@agentmonitors/source-incoming-changes`
- `@mike-north/cli` → `@agentmonitors/cli`
- `@mike-north/website` → `@agentmonitors/website`

Release pipeline: `release.yml` now uses `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` (repo
owner must add the `NPM_TOKEN` secret). Changeset `access` set to `"public"`.

No spec behavior changes. All package references in docs, source files, and tooling updated.

---

