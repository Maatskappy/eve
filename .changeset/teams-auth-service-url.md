---
"eve": patch
---

Teams' default auth now includes the conversation's `service_url` attribute, so a tool can address the conversation it was called from, for example to start a new thread there with `to(teams, { serviceUrl, conversationId })`.
