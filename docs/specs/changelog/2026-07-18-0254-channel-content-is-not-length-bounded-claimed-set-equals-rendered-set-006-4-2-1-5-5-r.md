## 2026-07-18 — Channel `content` is not length-bounded: claimed set equals rendered set (006 §4.2.1 ↔ §5.5) — Refs #436

Resolves a contradiction between §4.2.1 and §5.5 that produced an event-loss defect. §4.2.1 said the
channel `content` was "capped at 4000 chars" (with a truncation marker), while §5.5 said the channel
is an **uncapped** caller that "omit[s] `maxEvents` and claim[s] the full delivered set." Both were
true in the implementation at once: the channel reserved and committed the entire `DeliveryClaim`, but
the renderer capped the joined blocks at 4,000 chars — so when an early body exhausted the cap, later
blocks were dropped from the tag while every candidate was still claimed. Those claimed-but-unrendered
events were then excluded from subsequent hook-path delivery, remaining only manually discoverable via
`events list --unread` — **not** the automatic redelivery §5.5 guarantees.

- **§5.5 is authoritative.** The channel is genuinely not length-bounded (its surface is an MCP
  notification, not a single length-capped `additionalContext` string like the hook path). §4.2.1 now
  states the channel renders the **full** delivered set with **no** overall `content` cap, so the
  **claimed set always equals the rendered set** (§5.5 invariant). Only the **per-event** change
  summary stays bounded (§4.6, currently 800 chars each) so no single untrusted diff is dumped
  wholesale; the number of coalesced events is uncapped because all of them are claimed and therefore
  must all surface.
- **Implementation.** `apps/cli/src/channel-render.ts` drops the 4,000-char `content` cap and its
  channel-level truncation marker; per-event `diffText` bounding (in the transport-shared
  `delivery-event-render.ts`) is unchanged, and that marker is sanitized as part of the block so it
  can never reintroduce tag-breakout characters.
- **The hook-deliver transport is unaffected.** Its `additionalContext` remains length-bounded and
  keeps sizing **whole** blocks under its 4000-char cap (previewing, sizing, then claiming exactly the
  events it renders — §5.1/§5.5), so it too never claims an event it does not surface.

No change to runtime notify/debounce timing, urgency bands, projection, the unread/claimed/
acknowledged model, or the reserve → commit/release transport-state semantics (§4.5.1).

