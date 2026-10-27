---
issue: "None (consumer integration finding)"
status: implemented
last_updated: "2026-10-27"
---

# Durable callback data

An authored terminal hook may compute an exact usage or business report. Writing that report to separate storage can fail after inference. Hook exceptions do not retry, and making the inference-containing step retry can repeat paid inference. The existing native caller-notification step already retries after turn state commits, but it currently cannot carry an authored report.

Expose `setCallbackData(value)` from `eve/context`. A terminal hook calls it with JSON data. It updates the active callback's durable context without IO. The existing native completion notification forwards that committed value as `applicationData`, for completed, failed and cancelled turns. Callback transport failures retry the notification only. A new delivered turn clears prior data; the value is bound to the callback call ID. A turn without a native callback rejects the setter rather than implying delivery.

This does not change model output, add a workflow, expose arbitrary context, or define application authorization. Consumers authenticate their callback and validate their application data before acting. Existing callbacks that do not set data retain their exact payload.

Tests must cover the actual notification payload after serialization, completion and cancellation, a failed HTTP delivery followed by the same report, caller isolation and unchanged callbacks without data. The consumer additionally proves one provider invocation, one usage record and one settlement with the first delivery failing before storage and with a lost acknowledgement.

## Validation

The native Workflow integration covers notification retry without another model step, a later turn with the same call ID, cancellation, a callerless turn, and failed delivery after a successful report. The previous callerless binding accepted data incorrectly; clearing only inside the failing turn step delivered the previous report. Both mutations failed their observed-outcome assertions. The corrected native integration passes.

108 focused unit checks, package TypeScript and the mechanical invariants pass. Published docs and import snippets pass. The fixture-owned eval exercises the public context export from an authored tool; its CI execution remains pending. Consumer integration and immutable package delivery are separate rollout checks.

## Cancellation evidence

Real consumer execution reproduced a cancellation after provider dispatch being
reported as undispatched. Ordinary state rollback removed its accounting facts.
`defineState(name, initial, { onCancel: "preserve" })` retains explicitly selected
slots through cooperative cancellation, so terminal hooks can author an accurate
report. Ordinary state and history still restore the completed checkpoint.

## Observing delivery

The synchronous consumer can reach `session.waiting` before native notification
finishes. `callback.delivered` identifies the acknowledged `callId` on the same
stream. A separate publication step follows notification, so a stream write
retry does not repeat an acknowledged HTTP request. Callback-bearing terminal
streams remain open through that publication. Ordinary turn boundaries stay unchanged.
