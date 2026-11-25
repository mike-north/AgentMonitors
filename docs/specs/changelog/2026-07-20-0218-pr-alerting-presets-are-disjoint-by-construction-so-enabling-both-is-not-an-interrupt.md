## 2026-07-20 — PR-alerting presets are disjoint by construction, so enabling both is not an interrupt multiplier (003 §11.9) — Refs #444, #441

Shipping two presets a user may enable together risked reproducing #441's measured
interrupt-multiplier by construction. Measured directly with both presets' `--jq` run over the same
raw PR set: `pr-review` held `[1, 2]` while `my-prs` held `[2, 3, 4]` — PR 2 (red CI, undecided,
non-draft) was claimed by **both**, so every transition on it would deliver two alerts.

The server-side `--search` scope does not fix this in general. It does under the default
(`review-requested:@me` cannot match a PR you authored, since GitHub forbids requesting review from
yourself), but not under the label-driven model — which is exactly the model required when author and
reviewer share an identity, the case this whole workflow runs in.

`pr-review` now **excludes PRs with failing checks**, which makes the two memberships partition by
readiness under every scoping model: a red PR is not review-ready, it belongs to its author, and
`my-prs` already classifies it `ci-failing`. Re-measured after the change: `[1]` versus `[2, 3, 4]`,
disjoint. A test asserts every plausible PR state lands in at most one payload and fails if the
exclusion is removed.

Residual, by nature rather than defect: a PR merging leaves `pr-review` and enters `my-prs` as
`merged`. Under the default scope those are different PRs. Under a same-identity scope it is one
benign removal plus one actionable entry for the same merge — one dismissible fire, not a multiplier.
Delivery-layer cross-monitor coalescing (#441) is complementary; per #441's own guidance the
authoring-level fix is preferred and is what this does.

