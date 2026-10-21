---
"eve": minor
---

Session streams now use v27 committed-fact and progress lines, with line-position cursors and event identities instead of v26 metadata; `streamControlVersion` and `streamIdleReconnectPolicy` are removed, and terminal streams emit `{"$eve":"stream.ended"}`. Query opaque, immutable `SessionView` snapshots through `eve/events` instead of importing table rows; checkpoints move to version 17, so older sessions remain on their owning deployment instead of handing off to a v27 runtime. Entity IDs no longer collide with object dictionary keys, and lifecycle coordinates remain owned by the fold.
