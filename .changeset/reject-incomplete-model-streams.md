---
"eve": patch
---

Repair orphaned local tool calls in saved history before the next model request with an explicit unknown-outcome error. The repair never reruns tools or moves recorded results, and leaves provider-executed calls, approval requests and duplicate call IDs alone.
