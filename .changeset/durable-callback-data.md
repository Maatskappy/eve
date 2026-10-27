---
"eve": patch
---

Add `setCallbackData` in `eve/context` so terminal hooks can attach an authored JSON report to the existing native completion callback. Reports commit with turn state and callback retries deliver them without repeating model execution. New turns clear prior data; completed, failed and cancelled turns support the same report payload.
