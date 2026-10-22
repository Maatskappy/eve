---
"eve": patch
---

Dynamic skill supporting files now wait for sandbox access instead of delaying the first model call. Hooks can opt into early sandbox startup and app-owned preparation with `prewarm(ctx)` and `ctx.preload("sandbox", callback?)`.
