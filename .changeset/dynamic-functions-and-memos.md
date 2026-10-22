---
"eve": minor
---

Dynamic capabilities now use `defineDynamic(fn)` and `ctx.memo(key, fn)` instead of lifecycle maps and captured callbacks. Each evaluation rebuilds current callbacks and can reconnect clients; hooks receive committed context, changed parked entries fail, and old dynamic extensions need rebuilding.
