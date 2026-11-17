---
"eve": minor
---

Add `setCallbackData` so a `turn.settled` hook can commit a JSON report that the native completion callback delivers as `applicationData`.

`defineState` accepts `{ onCancel: "preserve" }` to keep a slot's updates when a cancelled call settles. A `callback.delivered` fact follows each acknowledged completion callback, and session streams answer authenticated `HEAD` requests with the cursor headers and no body.

`getRunStreams` from `eve/workflow/api` returns a run's durable streams for routes and steps that keep an append-only log beside a run.

Delivery receipts require an acknowledged callback response. A receiver that keeps reporting nothing pending produces no receipt. Terminal receipts remain valid transport facts after the session ends.

Transport receipts do not invoke authored handlers, including wildcard hooks.
