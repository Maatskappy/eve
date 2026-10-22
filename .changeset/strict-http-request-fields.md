---
"eve": minor
---

The eve channel now rejects unknown top-level fields on session creation, message, and control requests with HTTP 400 and a route-specific list of accepted fields. Typos and unsupported options no longer silently change request behavior; open payload objects and explicitly recognized remote-protocol fields retain their contracts, and unsupported remote protocols retain structured HTTP 409 upgrade guidance.
