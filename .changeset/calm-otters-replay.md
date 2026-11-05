---
"eve": patch
---

Authenticated session continuations accept an optional operationId and return a stable delivery receipt on retries, including after session completion or handoff. Concurrent copies admit one command, while changed payloads under the same operation ID return a conflict.

The bundled local World retains exact encrypted continuation bytes in its existing admission claim until publication, allowing interrupted claims to resume without weakening payload integrity checks.
