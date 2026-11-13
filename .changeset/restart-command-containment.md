---
'@agentmonitors/core': minor
'@agentmonitors/cli': patch
'@agentmonitors/source-command-poll': minor
---

Reconcile orphaned command-poll processes when the daemon starts on Linux, and record conservative ownership abstentions on macOS. Persist command ownership before spawning, verify boot and process identity before cleanup, and retain diagnostics for reaped processes and conservative abstentions, including detached descendants that keep their ownership marks.

Identify unreadable ownership marks by PID without attributing those processes to a command, and preserve those discovery abstentions before later identity queries.
Do not reclassify an already confirmed terminal incarnation as new unreadable work; reused identifiers with different process identities remain subject to discovery.

Require actual environment evidence for ownership: macOS system process listings mix argv and environment, so the shipped reader leaves same-user processes untouched with an explicit unproven-ownership reason. Linux retains environment-only ownership checks. A zombie/dead owner no longer suppresses reconciliation, and unavailable owner-state evidence withholds cleanup. Ownership queries are restricted to requested PIDs without per-survivor host-wide environment scans.

Record unchanged per-PID ownership uncertainty once and stop discovery when no signal was sent and no target was observed vanishing.

Apply one disappearance rule during initial discovery, gone batching, anchor confirmation, the signal gate and delivery ESRCH: retain the life and group suspicion and allow bounded rediscovery for marked late forks through the existing boot, mark and start-time gates. Remember a marked anchor's group before confirmation can lose it. Retire ownership only after fresh readable absence of its nonce, recorded group members and occupied recorded PIDs. Keep PID-only occupancy as a numeric suspicion during admission and restart, including reuse in another group, with no signal authority.

Retain original-group suspicion after direct-child exit so unmarked survivors receive conservative abstentions without numeric group signal authority. Continue verified late-fork cleanup despite unrelated unreadable ownership, preserving incomplete receipts and retryable lives.

Deduplicate unchanged unreadable-PID abstentions across post-signal snapshots. Retain original-group suspicion after a confirmed parent reap across journal reopenings, and retire the life only after no group member remains.

Batch gone-PID restart accounting and retire empty group hints at subsequent command admissions so completed commands do not accumulate unbounded restart work. Preserve possible-survivor suspicions and the life nonce for detached marked work when retiring empty hints. A hint refreshed during an admission read remains retained until a later snapshot confirms it empty; unrelated bookkeeping does not block empty-hint retirement. Persist newly discovered marked groups before signalling their anchors, retaining unmarked-survivor abstentions across journal reopenings. Keep distinct unreadable PIDs and changed uncertainty reasons as separate diagnostic outcomes.
