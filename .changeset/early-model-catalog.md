---
"eve": patch
---

Prewarm dynamic model metadata while new sessions wait for their first message, so the first model call can reuse cached context and output limits. Message-dependent selection and failed prewarming still resolve normally when a message arrives.
