---
"eve": patch
---

Model calls whose history ends on an assistant message, for example after answering an approval, now send a transient `Continue.` user message so providers without assistant prefill, like Anthropic, no longer reject the turn.
