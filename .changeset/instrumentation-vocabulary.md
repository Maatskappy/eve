---
"eve": minor
---

Instrumentation providers now use fact-aligned lifecycle events, run-based scopes, and `InstrumentationEvent<K>`; provider metadata moves to `model.call.settled`. OpenTelemetry preserves initiating message attribution across answer-only deliveries and marks failed session spans as errors without changing span names or trace schema 4.
