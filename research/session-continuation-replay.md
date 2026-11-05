---
issue: "T2242"
status: ready-for-review
last_updated: "2026-11-05"
---

# Session Continuation Replay Implementation Plan

**Goal:** Accept one authenticated `operationId` continuation once, return its stable receipt on retries, and reject changed payloads.

**Architecture:** Reuse Workflow's durable `hook_received` resume claim. A deterministic delivery ID binds the operation to the authenticated caller and exact public session. Read accepted commands from retained owner event logs. Before admission on a successor, append its run ID to an existing World stream owned by the original session; paginated snapshot reads recover this index even for sessions handed off before replay support. No additional worker or store.

**Tech stack:** TypeScript, existing Workflow World event storage, Vitest integration runtime.

## Constraints and scope review

- Only this dedicated worktree and branch; no push, provider access, release or deployment.
- Existing requests without `operationId` use their unchanged dispatch path.
- Capability header is `x-eve-continuation-replay: operation-id-v1`; successful operation responses contain exact `sessionId`, `operationId`, and stable nonempty `deliveryId`.
- Existing route authentication and onMessage policy run before receipt lookup. Reject anonymous operation requests.
- Observed failure: fresh delivery IDs permit duplicate paid turns after concurrent requests or a lost response. Existing atomic resume claims are the smallest supported fix; retained logs provide receipts without a second durable store.

## Implementation

- [x] Add an actual authenticated route integration regression using the existing real workflow runtime and a command-consuming inbox. Concurrent copies must return one receipt and produce one consumed message. Replaying after a simulated lost response and completed session must return that same receipt; changed payloads, anonymous calls, caller isolation and session isolation must be checked.
- [x] Parse optional nonempty `operationId`; add operation metadata to session sends/responds, scoped by the authenticated route principal. Canonical payload hashing excludes transport request IDs and delivery metadata. Return `operation_conflict` with HTTP 409 for changed content. Advertise the health header.
- [x] Add `session-inbox/replay.ts` for the operation-bearing dispatch only. Read retained owner hook events and the session-owned stream index. Serialize through the vendored Workflow serializer, atomically append with `resumeId` and canonical payload digest, and publish the existing workflow wake. Fail when the World cannot provide atomic resume claims. On ambiguous append failures read the retained receipt before reporting failure; never create a different operation.
- [x] Keep the handoff contract unchanged. Persist a successor owner link before admission, and read the current hook before history so a disposed predecessor cannot admit behind that read. Test two handoffs, including an existing session that moved before its first replayable operation.
- [x] Update public continuation documentation and patch changeset.
- [x] Run the focused tier-configured regression, existing inbox/handoff tests, named dedup mutation, format, lint, typecheck, unit tests, invariants and docs checks. The existing fork verify workflow now also runs the focused integration files and the HTTP fixture eval; remote CI execution remains root-owned because pushes are not authorized.
- [x] Self-review the diff and prepare the full handoff report. Signing is not configured in this checkout; per root instruction, stage an immutable tree and binary patch for the normal GitHub-signed commit path, with no unsigned commit.

## Self-review

Coverage includes admission, concurrency, lost response, completed replay, content mismatch, principal/session isolation, optional backwards compatibility and handoff. No new retry loop, storage layer, arbitrary limit or test-only runtime seam is planned. Receipt lifetime is the existing workflow retention lifetime. The backend's atomic claim is authoritative; a history lookup alone never grants new admission. The integration test must fail on the original route and a removed resume claim must fail the one-consumed-message assertion.

## Review correction: interrupted local claim

Reproduced against the actual bundled local World: fail the filesystem event promotion after the resume claim has been atomically reserved, then retry the same encrypted operation through the authenticated route. No event was committed; the retry returned 409 because serialization produced new bytes.

Correction plan, reviewed before runtime edits:

- Preserve the initial review tree and artifacts. Patch only pinned `@workflow/world-local@5.0.1` through existing vendoring transforms. Opt-in continuation claims retain their original serialized bytes alongside their existing digest; expose an internal claim-payload read that verifies the bytes against that digest. Leave claim identity and exclusive event publication unchanged.
- Eve decrypts and validates the reserved command's operation, caller, delivery and content before reusing the original bytes. A concurrent reservation gets one exact-byte convergence attempt through the same admission API. An uncommitted claim is never an accepted receipt.
- Include retained claim bytes in the existing zero-retention purge. No additional store, worker, lease or recovery loop. Remote backends remain unmodified.
- Run the new actual filesystem-fault regression, integrity and competing changed-payload cases, then the prior focused continuation/inbox/handoff integration and unit checks. Test setup uses the shipped bundled local World so the vendoring patch is exercised. Build with the frozen original lock and inspect generated output. Do not repeat the whole workspace suite.

Scope self-review: keeping exact bytes avoids weakening the backend's digest constraint or encryption. Optional payload storage leaves ordinary resumptions unchanged. Extending the existing purge is required because the claim now holds payload bytes. The patch is pinned and fails if expected upstream source changes.

Completed: the new filesystem-fault regression fails on the preserved review tree with 409 instead of 202 and passes with the correction. Focused continuation/inbox/handoff integration passes 13 tests; focused unit checks pass 68 tests. Typecheck, invariants, formatting, lint and the frozen package build pass. The generated local World and the built package's copy are byte-identical. The original lockfile remains unchanged. Remote CI and provider behavior are outside this local proof.

## CI correction: development World transport

The actual authored HTTP eval fails locally and in fork CI with the storage-capability error. Integration tests used the local World directly; the authored dev server uses the parent/worker World RPC facade. That facade drops the underlying backend's capability and does not forward its claim-payload read. Upstream defines `Hook.resumeCapabilities` as fresh, response-only backend attestation specifically for remote adapters.

Plan before runtime edits: add a parent/worker regression using the real local backend and an existing-version hook; have the parent derive the hook response's dedup attestation from its actual backend capability, without persisting it or relaxing the admission guard. Add the existing claim-payload read to the existing RPC operation table and prove its bytes survive that transport. Rerun the actual mock-model HTTP eval, the prior 13 integration and 68 unit checks, and targeted transport/type/build checks. Preserve the signed head as the fix base and stage a new immutable patch for root's signed commit. No provider access, dependency changes, or whole-workspace suite.

Scope self-review: the fix repairs the existing facade's representation of its backend. It adds no fake capability, numeric version cutoff, store or retry subsystem. Existing hooks gain a fresh backend attestation on read; they need no migration. Existing remote backends keep their own capability contract.

Completed: the actual continuation HTTP eval passes all 7 gates; the existing callback HTTP eval passes all 4. The direct transport regression fails before the fix and passes afterward; all 19 transport integration tests, the prior 13 continuation/inbox/handoff tests, and 68 focused unit tests pass. Typecheck, frozen package build, invariants, formatting and lint pass. The existing fork verification step now includes the transport regression. The lockfile is unchanged.
