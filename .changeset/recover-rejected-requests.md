---
"eve": patch
---

A model call that the provider rejects for its content (a 400, 413, or 422 response, such as an oversized image) no longer ends the turn. eve reissues the call once with attachments shown as their sandbox paths and the provider's error as a note, so the agent can work around the error or explain it.
