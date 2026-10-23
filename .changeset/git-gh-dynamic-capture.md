---
"eve": patch
---

Fix the `git__gh` tool from `eve/extensions/git` never appearing when `github` is configured. Its session-start resolver captured the config getter, which eve can't persist for a dynamic tool, so eve logged a non-serializable capture and dropped the tool.
