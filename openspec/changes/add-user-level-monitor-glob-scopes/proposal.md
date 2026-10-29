## Why

A `file-fingerprint` monitor can only watch project files today: bare-relative `globs` resolve
against the project workspace root, and with no workspace the source falls back to the daemon
process cwd. A user-level monitor (one living in the global config root rather than a project
`.claude/monitors/` directory) has no workspace to resolve against, so watching "my notes in `~`" or
"`/var/log/app.log`" has no well-defined form, and silently resolving against the daemon cwd would
watch the wrong paths. Authors need a declared, validated way to say "my home directory" or "this
absolute path".

Refs #194. Project-relative fan-out for user-level monitors (one definition → N workspace-scoped
instances) is out of scope and tracked in #258.

Source: 001 §6.1, §7.5, §8 (authoring surface); 003 §3.5 (§3.5.1–§3.5.7) and the user-level clause
of 003 §2.2 (resolution and validation).

## What Changes

- Each `globs`/`ignore` pattern's scope class is determined by its leading character: `/` absolute,
  `~` home-relative, anything else project-relative. No `scope:` field.
- `~` and `~/…` expand via the OS home directory to an absolute pattern; `~user` forms are rejected
  at `agentmonitors validate`.
- No-mixing rule: project-relative patterns cannot be mixed with absolute or home-relative patterns
  in one monitor (validate error); absolute + home-relative is allowed with a SHOULD-warn.
- Bare-relative globs in a user-level monitor are rejected at `agentmonitors validate` (initially
  gated on a `--user-level` flag or equivalent context).
- A user-level monitor whose globs are all absolute or all home-relative produces events with
  `workspacePath: null`, projected into all lead sessions via the existing workspace-agnostic path.
- **Behavior change:** for a user-level monitor, sources no longer fall back to the daemon process
  cwd for glob resolution (`context.workspacePath` is absent and the cwd fallback is forbidden).
  Project-level bare-relative behavior is unchanged.

Principles: PP3 (source vs runtime split — resolution stays in the source), PP4 (workspace-agnostic
events reuse the existing null-workspace projection into lead sessions only), AP5 (this adds scope
_classes_ per pattern, not a multi-root merge), BP3 (authoring mistakes caught at `validate`).

Contradictions resolved (details in `design.md`):

- 001 §8 lists "home-relative + absolute" as a rejected mix, while 001 §6.1 defers to 003 §3.5.3,
  which allows it (SHOULD warn, MUST NOT reject). This change adopts the 003 reading.
- 001 §6.1 and 003 §3.5 give different literal error messages for the `~user` and user-level
  bare-relative rejections. This change specifies the 003 wording (the source owns the rule);
  task 1.1 confirms it before implementation.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `sources/file-fingerprint`: glob base resolution gains absolute and home-relative scope classes,
  `~` expansion, validate-time rejection rules, and workspace-agnostic events.
- `sources/contract`: `context.workspacePath` is absent for user-level monitors and sources must not
  fall back to the daemon process cwd for them.
- `monitor/definition`: user-level `file-fingerprint` monitors declare workspace-agnostic globs
  (authoring surface; the rules themselves are owned by `sources/file-fingerprint`).

## Impact

- `plugins/source-file-fingerprint/src/index.ts` (pattern classification, `~` expansion,
  scope-schema/validation hooks).
- `apps/cli` `validate` (user-level context flag, `~user`, no-mixing, and bare-relative checks);
  command surface per `cli/authoring-commands`.
- `libs/core` runtime: user-level monitor evaluation supplies no `workspacePath`; events carry
  `workspacePath: null` (existing projection path).
- Published packages: `@agentmonitors/source-file-fingerprint`, `@agentmonitors/cli` (changeset);
  `apps/website` user-level monitor docs.
