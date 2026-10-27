---
"eve": minor
---

Memory document backend `read()` and `write()` inputs now use `signal` instead of `abortSignal`, matching other eve I/O options. Update custom backends and direct calls; memory and tool execution contexts still expose `ctx.abortSignal`.
