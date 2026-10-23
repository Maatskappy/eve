---
"eve": patch
---

`eve__task_wait` now waits at most 30 minutes. A call that omits `timeoutSeconds`, or asks for more, returns after 30 minutes without a result, so a task that never reports can't hold a turn open indefinitely.
