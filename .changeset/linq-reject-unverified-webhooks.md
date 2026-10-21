---
"eve": patch
---

`linqChannel` now treats any falsy `webhookVerifier` result as a rejected webhook and responds `401`, matching the other built-in channels.
