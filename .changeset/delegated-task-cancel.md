---
"eve": patch
---

Cancelling an agent task now ends it immediately instead of leaving it available for another message; late notices and questions are discarded, and its run no longer delays the next turn. Late-child shutdown is best effort with logged failures; usage from cancelled runs still counts toward session limits.
