---
"eve": patch
---

Add an OpenTelemetry span for `decide` calls, including automatic model selection and tool approval decisions. Spans record model identity, token usage, Gateway cost when available, and failures while respecting trace and content policies.
