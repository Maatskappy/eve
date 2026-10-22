---
"eve": minor
---

Channel delivery hooks now receive typed `ChannelDelivery<TState>` payloads and return a replacement payload or nothing to preserve the input; imported history remains framework-owned. Authored channels match their path-derived identity in hooks and resolvers, including `channel:eve` for the default HTTP channel; remove `kindHint` and use `audience()` rather than `metadata().audience` to classify visibility.
