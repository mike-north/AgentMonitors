## 2026-07-20 — Object identity in a delivered event block must not be lost to an Interpret digest, and an authored monitor name must not be blank (002 §1.1.8, §5.4, 006 §4.2.1) — Refs #449

Round-9 review follow-up to the 2026-07-19 `#449` entry above. Three fixes:

**A digest is not an object identity.** `DeliveryEventSummary.summary` prefers the per-recipient
Interpret digest (G14, 002 §1.1.8) when one was produced; a digest is a prose reading of the
_change_, not necessarily a naming of _which object_ changed. `buildEventBlock` (006 §4.2.1) had
been reading `summary` for its per-object detail line — the same line #449 introduced specifically
so a named multi-object source could still name the object that moved — so a named multi-object
`prose` monitor's delivered block could silently carry no object identity at all once Interpret ran.
A new field, `DeliveryEventSummary.objectDetail`, carries the deterministic per-object text
(`MonitorEventRecord.summary`, never digest-replaced); the transport-shared block renders it instead
of `summary`. `summary`'s digest-preferring contract is unchanged (existing regression test still
asserts the digest lands there for `claimDelivery`).

**A whitespace-only authored name must not win the 002 §5.4 title-precedence race.**
`monitorFrontmatterSchema`'s `name` field previously rejected only the empty string (`.min(1)`),
which passes a value like `"   "` — non-empty, but blank. Because an authored `name` unconditionally
wins the title-precedence rule, a whitespace-only name silently displaced a source's real title with
a blank line, on both a persistent monitor's frontmatter and an ephemeral watch's `--display-name`
(its only naming affordance, 007 §4.6). Both authoring boundaries now reject a whitespace-only name
with an explicit, actionable error rather than accepting it silently.

**`events list --format text` did not control-safe-escape untrusted fields.** The format documents
one record per line, but `title`/`summary`/`monitorId` are source- or author-controlled text that can
carry a raw CR/LF (forging a second row) or a raw terminal escape sequence (reaching the terminal
unmodified). These fields are now passed through a single-line-safe transform before interpolation:
line-breaking characters (CR, LF, and the Unicode line/paragraph separators) collapse to a space, and
every other C0/C1 control character is escaped to a visible `\uXXXX` form.

Also fixed: the 006 §4.2.1 rendering-contract prose still said the detail line is "omitted only when
it repeats the title," which stopped being true once the body-equality suppression (also #449) was
added — it is now omitted for either match. A Markdown inline-code span illustrating the detail line
had also been split across a line break by prior wrapping, which renders incorrectly; it is now a
single line.

