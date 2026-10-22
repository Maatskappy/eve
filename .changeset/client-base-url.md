---
"eve": minor
---

`Client`, `SessionStore`, and the React, Vue, and Svelte `useEveAgent()` bindings take their target as `baseUrl`, which accepts an absolute URL, a same-origin path prefix, and query parameters. `new Client()` still requires it, with `""` for same-origin routes; the store and bindings default to `""`, and `agent` cannot be combined with `baseUrl`.
