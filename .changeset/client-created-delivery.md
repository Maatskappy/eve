---
"eve": minor
---

`client.sessions.create({ message })` resolves `{ session, delivery }`, where `delivery` is the first message's `Delivery`; creating a session without a message still resolves only `{ session }`. A `ctx.agent()` message result has `status` `completed`, `cancelled`, or `failed`, and only a failed result carries its required `error.message`.
