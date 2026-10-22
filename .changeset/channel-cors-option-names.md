---
"eve": minor
---

Channel CORS options use `allowHeaders`, `exposeHeaders`, and `preflight.statusCode` in place of `allowedHeaders`, `exposedHeaders`, and `preflightStatus`. Unsupported option names fail with migration guidance instead of silently using defaults.
