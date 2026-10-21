---
"eve": minor
---

Frontend stores and React, Vue, and Svelte bindings can follow another store's same-session receipts; `followWhile(view)` replaces `followIdle` without interrupting local delivery or resume obligations. Historical catch-up never invokes `onFinish` or replays execution-error callbacks, including for locally submitted work. `status` now reports outstanding work: a turn waiting only on a person is open while `status` is `idle`, so read `activeTurn(view)` to steer or cancel it.

To keep the old `followIdle: false` behavior, which closed the stream once no turn, task, or sign-in was pending, import `activeTurn` and `idle` from `eve/events` and pass `followWhile: (view) => !idle(view) || activeTurn(view) !== undefined`. Omit `followWhile` to keep following between turns, as `followIdle: true` did.
