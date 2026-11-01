## Context

001 §6.1 states the `MONITOR.md` authoring contract for user-level `file-fingerprint` monitors and
defers full resolution/validation rules to 003 §3.5. The two documents disagree in two places; this
change records the call made and what remains open.

## Decisions

### Sigil syntax instead of a `scope:` discriminator

The leading character of each pattern declares its scope class. Rejected alternative: a separate
`scope:` field on the `watch` block — it duplicates information already present in the pattern and
allows a field/pattern disagreement that would itself need validating.

### Reject `~user`

`~user` expansion needs another user's home lookup through platform APIs that are unreliable in a
daemon context; `~/…` covers the common intent ("files in my home directory"). Rejected
alternative: best-effort `~user` expansion — silent mis-resolution under a daemon is worse than a
clear validate error.

### No mixing project-relative with workspace-agnostic patterns

One monitor has one `sourceState` and one baseline. A baseline spanning user-level files and
project-relative files is ambiguous when one daemon serves several workspaces. Rejected alternative:
allowing the mix and resolving the project-relative half per workspace — that is the fan-out
machinery of #258, explicitly out of scope.

### Absolute + home-relative mixing is allowed (contradiction resolved)

001 §8 lists "home-relative + absolute" as a rejected mix; 001 §6.1 says all patterns MUST share one
class but defers to 003 §3.5.3, which allows absolute + home-relative (both workspace-agnostic) with
a SHOULD-warn. This change adopts the 003 reading: both classes resolve without a workspace, so the
baseline-ambiguity rationale does not apply, and rejecting it would be a false-positive footgun.
Rejected alternative: strict single-class rule from 001 §6.1/§8.

### No silent `cwd` fallback for user-level bare-relative globs

Resolving bare-relative user-level globs against the daemon process `cwd` would watch the wrong
files. Rejected alternative: accept and resolve against `cwd` — wrong paths with no signal.

## Open Questions

- Error literals (task 1.1): the change specifies the 003 §3.5 wording. 001 used `~user home expansion is not supported; use an absolute path or ~/…
instead.` and `Bare-relative globs in a user-level monitor are not supported until
project-relative fan-out lands (Refs #258). Use an absolute path (/) or a home-relative path (~/)
instead.`; 003 §3.5 worded both differently.
- How `validate` learns a root is user-level (`--user-level` flag vs inferring from the path) is left
  to implementation; the observable contract is "bare-relative + user-level = validate error".
