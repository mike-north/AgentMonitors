## 2026-07-19 — `daemon run --detach`'s `--log` parent-directory tightening is default-location-only, and its log file fails closed against a symlinked path (002 §3.1) — Refs #389

Round-5/round-6 review follow-up to the entry directly below, which said every log parent "now
uses `ensurePrivateDir`" and "a permissive pre-existing directory is tightened" unconditionally.
That was true only for the default (Agent-Monitors-owned) location; a custom `--log` path's parent
may be a directory the user owns for other reasons (a repo checkout, a shared logs directory), and
unconditionally chmod-ing it to `0700` silently stripped group/other access — a functional
regression, not a hardening. `openLogFd` now takes an `isDefaultLocation` flag: a _missing_ parent
is always created `0700` (there is no pre-existing mode to preserve either way), but an _existing_
parent is tightened only at the default location; a pre-existing custom parent is left exactly as
found, mirroring the existing `--socket`-directory precedent.

Separately, `restrictExistingPathMode` correctly no-ops on a symlinked log path (refusing to
tighten or follow it), but the subsequent `openSync(logPath, 'a')` still followed the symlink,
appending the daemon's stdout/stderr into whatever it pointed at without ever securing that
target's mode — defeating the owner-only file invariant this section otherwise guarantees. The
final open now uses `O_NOFOLLOW` (failing with `ELOOP`, reported as a clean spawn error, when the
last path component is a symlink) and `fchmod`s the resulting descriptor rather than the path, so a
planted symlink at the log path can no longer redirect the daemon's output onto an unintended
target.

