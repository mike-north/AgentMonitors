---
'@agentmonitors/cli': patch
'@agentmonitors/core': minor
---

The channel no longer marks an event claimed just because its push call resolved. A Claude Code session started without a channel listener drops channel events silently, and those events were then skipped by the hook path too. The channel now tags each push with a `delivery_id` and commits it only once the session transcript shows that Claude Code accepted that push. Otherwise it releases the rows, so the hook path delivers them, and stops pushing for the rest of that channel process. `session start` and `hook deliver` record the session's transcript path (the path only) for this check. `doctor` replaces the `channel-registration-unverified` advisory with `channel-route-unproven`, shows the channel route on the channel row and in JSON (`route`), and counts the channel as listening only once a push is confirmed. `verify` reports the channel route (`channelRoute` in JSON). `@agentmonitors/core` adds `scanClaudeTranscriptForChannelPush`, `isClaudeTranscriptPathForSession`, `isChannelDeliveryId` and `CHANNEL_DELIVERY_ID_META_KEY` for reading Claude Code transcripts.
