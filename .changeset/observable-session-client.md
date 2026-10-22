---
"eve": minor
---

Frontend snapshots expose opaque `view`, `messages`, and `agents` directly with `idle | busy | resuming` status, separate errors, and shared tool-part `state`; all five callbacks remain. Committed state no longer waits for unrelated POST receipts, restored history does not replay error/finish callbacks, and Stop still targets the observed or pending submission’s turn without withdrawing queued messages.
