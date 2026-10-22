---
"eve": patch
---

Framework integrations such as `withEve` now start the eve dev server with Node.js when the framework runs under `bun --bun`, and fail with an actionable error if no Node.js is on `PATH`. `eve dev` started on Bun now exits immediately with the same guidance, and dev-server startup errors keep their underlying cause. Thanks @haydenbleasel for reporting this in #101.
