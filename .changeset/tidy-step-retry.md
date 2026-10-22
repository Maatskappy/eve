---
"eve": patch
---

A durable step interrupted after publishing but before checkpointing now runs again from its checkpoint without writing its events twice or running its started tool calls again; the model reads which calls may have taken effect and decides what to repeat. A turn fails with `STEP_INTERRUPTED` after more than three interrupted steps, or with `STEP_FAILED` when a step fails every retry, and the session stays open instead of ending.
