---
"eve": patch
---

`eveChannel({ onMessage })` now receives `ctx.eve.sessionId` on the message that creates a session, not only on follow-ups, and it is typed as `string`. eve reserves the ID before `onMessage` runs, so it matches the ID the client gets back and every later `onMessage` sees.
