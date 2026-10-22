---
"eve": minor
---

Unify tool and connection approvals under `Approval`, remove `approvalKey` and `ApprovalContext.approvedTools`, and preserve automatic-review replay and clearance provenance. `once()` now returns a status object; a custom policy must return that decision unchanged to use or record remembered per-tool consent.
