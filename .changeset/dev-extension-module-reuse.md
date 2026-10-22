---
"eve": patch
---

`eve dev` no longer grows in memory on every rebuild when the agent mounts extensions. Each compile used to evaluate every extension module again, even when it had not changed, and kept the old copies; unchanged extension modules now reuse their evaluated module, as app modules already did. Thanks @callicles for reporting this in #5203.
