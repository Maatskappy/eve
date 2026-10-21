---
"eve": minor
---

Session commands return serializable `Delivery` receipts with reusable, independently abortable `stream()` and `result()` reads; settled results carry the delivery outcome and failure details without retaining an event log. Import shared contracts from `eve/sessions`, query immutable session snapshots through `eve/events`, and use channel context—not session information—for continuation aliasing; client handles remain type-only, local fresh starts use `newSession()`, eval/CLI results use `reply`/`data`, and `invokeTool` returns call-shaped outcomes.
