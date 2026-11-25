## 2026-06-30 — User-level monitor glob scoping: sigil-based syntax + workspace-agnostic events (001 §6.1, §7.5, §8; 003 §2.2, §3.5) — Refs #194

Formalizes the 2026-06-30 design-session decision on user-level monitor glob scoping for the
`file-fingerprint` source. All new rules are marked **target**; project-level behavior is
unchanged.

### Decision summary (v1 — this issue)

1. **Sigil-based scope, no discriminator field.** Leading `/` ⇒ absolute path; leading `~` ⇒
   home-relative; bare relative ⇒ project-relative. Matches universal Unix intuition and requires
   no new vocabulary.
2. **`~` / `~/…` expand to `os.homedir()`.** `~user` (other users' homes) is **not** supported
   and is rejected at validate time.
3. **No mixing of scope classes within one monitor.** Absolute + project-relative and
   home-relative + project-relative mixes are rejected by `agentmonitors validate`. Mixing
   absolute + home-relative is warned but not rejected.
4. **Ship the project-independent forms** (absolute / home / fixed file) — they emit
   workspace-agnostic (`workspacePath: null`) events that project into all lead sessions, reusing
   the existing `sessionsForWorkspace(null)` path.
5. **Bare-relative globs in a user-level monitor are rejected at `agentmonitors validate`** until
   project-relative fan-out is implemented (issue #258). Project-level monitors keep their
   existing behavior: bare-relative = workspace-relative, unchanged.

### Spec changes

- **001 §6.1 — new (target).** Authoring-level spec for the sigil syntax: leading-character
  scope table, `~` expansion rule, no-mixing rule, and the bare-relative-user-level rejection.
  Concrete `globs` authoring examples for all four cases (home-relative user-level, absolute
  user-level, bare-relative project-level, bare-relative user-level rejected). Cross-reference
  to 003 §3.5.

- **001 §7.5 — new (target).** A `~/notes/**/*.md` user-level monitor example that proves the
  home-relative form is the correct authoring pattern for files in the user's home directory; the
  resulting events are workspace-agnostic and project into all lead sessions.

- **001 §8 — extended.** Additional validate obligations listed for the three new rejection cases
  (bare-relative + user-level, `~user`, mixed scope classes).

- **003 §2.2 — clarified.** `context.workspacePath` note updated: for user-level monitors using
  absolute or home-relative globs, `workspacePath` is `null` and the source MUST NOT use the
  daemon process `cwd` as a fallback. Cross-reference to §3.5 added.

- **003 §3.5 — new (target).** Full source-level spec for sigil-based glob scope resolution:
  - §3.5.1 — scope-class determination table (per-pattern, leading-character sigil)
  - §3.5.2 — `~` expansion rule and `~user` rejection
  - §3.5.3 — no-mixing rule with accepted/rejected combinations and rationale
  - §3.5.4 — user-level monitor bare-relative rejection (validate guard + mechanism)
  - §3.5.5 — workspace-agnostic events (`workspacePath: null`, `sessionsForWorkspace(null)`)
  - §3.5.6 — six concrete `globs` examples (valid and invalid)
  - §3.5.7 — required test/validation matrix (8 scenarios drawn from the decision memo Proof)

### Follow-up

Project-relative fan-out (one user-level definition → N workspace-scoped runtime instances,
each with its own baseline and event stream) is tracked in issue #258, sequenced after #192.
This release ships the cheap, high-value project-independent forms only.

