---
"eve": patch
---

Fix `eve dev` running out of memory after repeated saves: each rebuild now compiles in a short-lived worker that releases its memory, and a rebuild that exhausts the heap fails without stopping the server. Modules imported by relative path now carry their `package.json` metadata, so `"sideEffects": false` tree-shakes them the same way between rebuilds, and in `"type": "module"` packages a default import of a CommonJS package that sets `__esModule` now gets that package's `module.exports`, as in Node.
