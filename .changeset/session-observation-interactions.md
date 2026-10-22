---
"eve": minor
---

Session observations now distinguish session work, open interactions, and running calls and tasks. Use `openInteractions(view, { about })` to inspect a call's or task's blockers; `waiting` no longer accepts call or task IDs, and the live `requestStatus` selector has been removed. Settled `Delivery.result().status` remains available.
