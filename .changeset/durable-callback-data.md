---
"eve": patch
---

Add `setCallbackData` so terminal hooks can commit JSON reports for native completion callbacks. Explicit `defineState` cancellation preservation keeps external-effect facts available to terminal hooks; the `callback.delivered` stream receipt identifies an acknowledged result without repeating execution.
