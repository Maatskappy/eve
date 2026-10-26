---
"eve": patch
---

Session streams read from the local Workflow world, such as in `eve dev`, no longer sometimes deliver events out of order. A reader that opened while a batch of events was written could get a later event, such as `step.started`, before an earlier one, such as `turn.started`. The local world now writes each batch in order.
