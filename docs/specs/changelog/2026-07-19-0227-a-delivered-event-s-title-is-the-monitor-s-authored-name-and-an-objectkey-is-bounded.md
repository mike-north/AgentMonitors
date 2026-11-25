## 2026-07-19 — A delivered event's title is the monitor's authored `name`, and an `objectKey` is bounded in human-facing text (002 §5.4, 003 §2.8, §4.4, §11.4) — Refs #449

Previously the event `title` was whatever the source wrote, and `command-poll` writes
`"Command output changed: <objectKey>"` with `objectKey` defaulting to the joined argv. A live
delivery therefore headlined itself with ~400 characters of its own `jq` program while the monitor's
authored name — "My PRs — CI, review feedback, state changes" — appeared nowhere in the delivery.
That contradicts the principle #434/#438 established (delivered text is the agent's action surface
and must be self-sufficient): a headline that is the monitor's own implementation conveys nothing and
consumes context on every delivery.

Two rules now: **002 §5.4** — the runtime, not the source, chooses the title: the monitor's authored
`name` when present, otherwise the source title unchanged (documented fallback). The source's
per-object text stays as the `summary`, and source identity stays on `objectKey`/`payload`, so no
information is lost. Because the choice happens once at materialization the title is
transport-independent by construction — hook and channel cannot diverge. **003 §2.8** — an
`objectKey` is an identity, not a headline: a source interpolating one into `title`/`summary` bounds
it with `displayObjectKey` (≤60 characters, otherwise a prefix ending in `…`). Keyed collections bound
only the monitor-scope half of `<scope>#<key>`, keeping the informative item key whole. §4.4
(`api-poll`) and §11.4 (`command-poll`) updated to cite both rules.

Delivery rendering follows: both injecting transports' shared per-event block now renders the
`summary` on its own line beneath the title, omitted when the two are identical (006 §4.2.1). Without
it, a per-object source's delivered block would name no object at all once the title became the
monitor name — the exact self-sufficiency regression #434/#438 guards against.

Review of the above corrected three over-claims in the first draft of these rules. (1) §2.8's bound
was stated as a **universal** MUST, but `file-fingerprint`'s absolute path, `incoming-changes`'
repository path, keyed collections' item keys, and the `api-poll` composite fallback key are all
still unbounded. The rule is now scoped to **configuration-identity** keys (a joined argv, a URL) —
the cases where a key is long because of how the monitor is written and where a head-truncated prefix
stays informative — and the path-like cases are documented as deliberately excluded, because a path's
informative part is its tail and head-truncation would destroy it (a path-aware ellipsis is
follow-up). (2) 002 §5.4 claimed the source title is "never lost"; `Observation.summary` is optional
and MAY differ from the required `title`, so a named monitor whose source sets a distinct summary
does drop the source title from delivered text. §5.4 now carries a compatibility table for all three
observation shapes, and 003 §2.1's field table no longer describes `title` as the inbox-item title.
(3) The bound truncated by UTF-16 code unit, which split astral code points (`"a".repeat(58) + "😀x"`
emitted a lone high surrogate into durably persisted text); it now cuts at a grapheme-cluster
boundary, so a flag or ZWJ sequence is kept whole and the result may be shorter than the bound.

Ephemeral monitors: an explicit `--display-name` now propagates into the authored-name signal, so a
named ephemeral watch headlines with its display name like a persistent monitor's `name:` (007 §4.6
"same pipeline semantics"), including after the definition is reconstructed from its durable record
on daemon restart.

`api-poll` additionally **redacts** the URL it interpolates (userinfo/query/fragment stripped, the
treatment its warning text already had) before bounding it. Title and summary are durably persisted
and delivered to agents, and a polled URL routinely carries a token, so the redaction that protected
diagnostics has to protect delivered text too; `objectKey`/`payload.url` keep the exact URL.

Not addressed here: issue #449's third item, a semantic diff hint for `json-diff` `diffText` (the
"PR #443 became MERGED, PR #447 appeared" rendering). That is the presentation half of #440 and
remains open.

