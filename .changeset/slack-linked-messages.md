---
"eve": patch
---

Slack messages that link to another Slack message now bring that message's content into the turn. Slack sends events before it unfurls links, so the agent used to see only the URL. eve reads up to three linked messages in the current conversation or in public channels, renders them like the triggering message (including tables), and adds them in a `<slack_linked_messages>` block. Inbound `data_table` blocks also keep their string `caption` and show an `action_cell`'s fallback value.
