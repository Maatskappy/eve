---
"eve": minor
---

Channel delivery hooks return replacements for message, answers, context, and output schema, not durable state. Apply state changes through `channel.state`; answering a Chat SDK card now also preserves the delivery's context.
