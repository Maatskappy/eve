---
issue: https://github.com/Maatskappy/dassie/actions/runs/40741483639
status: implementation
last_updated: 2026-10-28
---

# Dassie artifact versions use the upstream sandbox image

The reviewed `0.72.1-dassie.1` package made the staging deployment request
`vcr.vercel.com/vercel/eve/base:0.72.1-dassie.1`. That image was never published.
The native sandbox preparation failed with `404 Image not found` in Dassie run
40741483639, commit bdf21a1f97685c9a682084a1e312f966f5855171.

This fork changes authored callback state and cancellation semantics in the
package. It does not change the sandbox filesystem or its requirements. Release
it as `0.72.1+dassie.2`: the existing image resolver strips build metadata and
selects the upstream `0.72.1` image for Vercel and local providers. Keep the old
release immutable. Do not strip prerelease tags in the resolver, because real
upstream prereleases have their own images. Do not add a retry or skip prewarm.

Implementation and proof:

- Change only the artifact version and add a regression using the actual package
  metadata with both registry resolvers.
- Build and pack the artifact; inspect its version and selected image references.
- Run focused image/header tests and the dependency workflow before merging.
- Release a new immutable artifact from reviewed source, update both Dassie
  dependency pins/lockfiles in a reviewed PR, then verify actual staging prewarm
  and runtime health through the normal deployment workflow.

The initial local runtime observation agrees with the deployment failure: both
registry resolvers select the nonexistent `0.72.1-dassie.1` tag. A passing local
resolver test establishes selection, not remote image availability. The actual
staging deployment remains required proof.
