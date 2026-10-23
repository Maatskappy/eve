---
issue: "https://github.com/vercel/eve/pull/5307"
status: implemented
last_updated: "2026-10-23"
---

# Hydrated source coverage

## Reader contract

`meta.position` identifies a materialized event at its original source line and fact index. In root `SessionStore` hydration, `position(view)` comes from complete projected lines, independently of the saved source coverage. Neither event counts nor a shared `ClientSession` handle prove which source lines this store has read.

A reader that consumed later source lines without producing events can attach `meta.next` to the last event of a complete line. It is the exclusive end of that known source coverage, not a relocated fact or an extra event. Persist the metadata with the events; applications do not maintain another cursor.

```text
source 0..6 -> 11 facts -> projection position 7
source    7 -> no facts -> last fact's meta.next = 8
                          store source cursor = 8
```

`convertLegacyEvents(records)` supplies this evidence when trailing records emit nothing. The existing `initialEvents` / `initialSession` constructor remains valid, including after JSON persistence. An old converted log without this metadata cannot recover the missing source coverage from its facts; reconvert its original archive.

## Store behavior

The store publishes and resumes from its own committed source coverage: the complete projected prefix plus reader-attested empty source lines. `initialSession.streamIndex` positions the handle only. A handle advanced independently, including before construction, never extends the store's prefix.

Coverage must be a safe integer past the annotated complete source line. Coverage on an unfinished line, or a later materialized event inside a range already declared empty, is rejected. As with the facts themselves, callers must supply the ordered prefix as read, not forge or edit reader metadata.

A partial line is not acknowledged. Coverage from a preceding complete prefix survives partial hydration, detach, transport rollback, and resume. `newSession()` clears it. No projection, server authorization, execution, or stored-line format changes.

The descendant follower added in #5307 already calls `Conversation.advancePosition` to include consumed empty lines in a child's observation position. That existing child-observation contract stays unchanged. The root store instead exposes coverage in `session.streamIndex`, leaving its independently folded `position(view)` intact. Reusing `advancePosition` for root hydration would erase this requested distinction and change the meaning of existing root views. Consumers use the store's session cursor to resume, not a child's observation position or the root's projected position.

## Scope and proof

The store regression first fails with eight saved v26 records, 11 facts, projection position 7, and an incorrectly published cursor 7. It then verifies cursor 8, the actual resume GET's `startIndex=8`, JSON persistence, detach/reopen, and a following partial native commit. Native history, run-ahead handles, invalid coverage, contradictory prefixes, and reset are separate negative controls at the same owner boundary.

Trailing position markers on live streams and `ClientSession.snapshot()` still under-claim when they produce no events. This patch does not promote a transport tail header or another reader's cursor as evidence, or redesign those read APIs. Their conservative under-claim remains a separate follow-up, not a reason to acknowledge unread data here.
