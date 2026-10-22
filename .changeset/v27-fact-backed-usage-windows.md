---
"eve": patch
---

Evaluate `limits.sessionUsage` from v27's committed usage facts, preserving delegated spend and approval windows across durable handoffs without a second usage accumulator. Thanks @ruiconti for the session-usage policy and cache-read accounting in #5028 and #5011, and @AndrewBarba for the underlying v27 work.
