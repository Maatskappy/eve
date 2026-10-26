---
"eve": patch
---

The local Workflow world, used by `eve dev`, now writes each batch of session events in order. Before, a reader that opened while a batch was being written could get a later event, such as `step.started`, before an earlier one, such as `turn.started`.
