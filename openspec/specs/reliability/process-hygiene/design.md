# reliability/process-hygiene — Design Notes (non-normative)

Agent Monitors is a process the user leaves running. A long-running local daemon that spawns other
processes loses trust through erosion — leaked children, warm laptops, strays found in Activity
Monitor — so this capability makes the system accountable for everything it starts that remains
within the containment boundary. The non-normative _why_ is the posture doc
`docs/product/reliability-and-process-hygiene.md`; this capability is the testable _what_.

## Why the containment boundary is defined the way it is

"No orphans" is unfalsifiable as an absolute. "No orphans within the boundary, and boundary exits
are either swept (identity kept) or plainly documented as escapes (identity erased)" is testable.
The boundary definition is what lets lifetime bounds, sweeps, and identity-verified cleanup be
stated without hedges.

A process that detaches but keeps its identity marks is still ours and still accountable; only a
process that both detaches _and_ erases its identity has escaped. The system never guesses about an
escaped process: a missed cleanup is recoverable and reportable, a wrong kill is not.

## Current scope vs the target contract

Today only the original-process-group escalation of a monitored command is enforced (POSIX
SIGTERM→SIGKILL to the original group; Windows `taskkill /T /F`), and only while the spawning
daemon is alive. The target contract — full-boundary bounds and the capability probe (#480),
daemon-death-independent bounds (#470), the restart sweep and stray collection (#478, #426),
identity-verified cleanup (#479), abstention warnings (#507), the power posture (#469), and the
milestone-M3 durable-state and verification-gate commitments — lives in `openspec/changes/`.

## Non-goals

- **Not a process manager/supervisor** for the user's own workloads.
- **Not a resource governor** — the power posture governs our machinery, not the user's commands.
- **Not a security boundary.** Process hygiene protects the user from _our_ mess; it is not a
  sandbox against hostile code (BP4 defines the actual local trust boundary).
- **Not zero-orphans-through-hardware-failure.** A power loss leaves the OS to reap; the commitment
  (target, #478) is that the next start reconciles.
