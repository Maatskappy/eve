---
"eve": patch
---

Fix `eve dev` running out of memory after repeated saves. Each rebuild now compiles the agent in a short-lived worker, so its bundles are released afterward, and a rebuild that exhausts the heap fails without stopping the server. Workspace packages marked `"sideEffects": false` now tree-shake the same way whether a module is imported by relative path or by package name, so unchanged modules no longer produce different bundles between rebuilds.
