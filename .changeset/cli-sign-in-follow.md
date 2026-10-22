---
"eve": patch
---

`eve remote invoke --resume` now follows the original turn after sign-in instead of returning the old delivery's awaiting-input result. Successive sign-ins in the same turn can be resumed one at a time, including after an interrupted follow; ordinary working invocations still follow their original delivery.
