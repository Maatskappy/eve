---
"eve": patch
---

Fix `eve dev` running out of memory after repeated saves: rebuilds now compile in a worker that is replaced once its memory grows past a limit, and a rebuild that exhausts the heap fails without stopping the server. Modules imported by relative path now carry their `package.json` metadata, so `"sideEffects": false` tree-shakes them the same way between rebuilds, and in `"type": "module"` packages a default import of a CommonJS package that sets `__esModule` now gets that package's `module.exports`, as in Node.
