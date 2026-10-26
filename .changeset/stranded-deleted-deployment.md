---
"eve": patch
---

A message to a session whose owner run is pinned to a deleted Vercel deployment now answers `409 session_stranded` (and a channel message starts a replacement session) instead of being accepted and never processed. Every run records `$eve.deployment_url`, and ingress probes an owner on another deployment before committing a command.
