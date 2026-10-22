---
issue: "TBD (maintainer-requested plan; no dedicated issue)"
status: proposed
last_updated: "2026-10-21"
---

# Events on dynamic MCP connections

## Proposal

Let an app choose a user's MCP account at runtime and enable events on that
connection. For example, each user can connect their own Bird account and ask
eve to watch incoming email, without a connection file for every account.

Start with root-agent connections returned by `defineDynamic` at
`session.started`, a concrete `connect(...)` provider, and shared authored
callbacks. Preserve the existing watch workflow, subscription API, and callback
shape. This PR proposes the implementation; it does not enable the feature.

## Authoring

Proposed example against the current dynamic connection API:

```ts
// agent/connections/bird.ts
import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { connect } from "@vercel/connect/eve";
import { getBirdAccount } from "../lib/accounts";
import { handleBirdEvent } from "../lib/bird-events";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const principal = ctx.session.auth.current;
      if (principal?.principalType !== "user") return null;
      const account = await getBirdAccount(principal);
      if (!account) return null;

      return defineMcpClientConnection({
        url: account.mcpUrl,
        description: "Read email and watch new messages",
        instanceKey: account.connectionKey,
        auth: connect(account.connector),
        experimental_events: {
          onEvent: handleBirdEvent,
        },
      });
    },
  },
});
```

`getBirdAccount` and `handleBirdEvent` are application functions. The account
lookup must authorize the user. `connectionKey` is a stable, non-secret account
identity that changes when the account or auth configuration changes.
The callback receives the existing `event`, `origin`, `auth`, `deliveryId`, and
`attachSession` fields. `onGap` and `onTerminated` work the same way.

Support a single definition, a named map, or `null`, following existing dynamic
connection naming. The first version excludes event-enabled `turn.started`
results, auth resolver functions, and callbacks that depend on transient
resolver-local state. Use shared module callbacks and load current application
data through an authorized lookup. Ordinary dynamic connections keep their
existing session and turn behavior.

## Current gaps

- [Dynamic resolution](../packages/eve/src/runtime/resolve-connection.ts)
  explicitly rejects `experimental_events`.
- [Route registration](../packages/eve/src/internal/nitro/host/application-route-registry.ts)
  creates receivers only for event-enabled connections known at build time.
- The [receiver](../packages/eve/src/internal/nitro/routes/connection-events.ts)
  obtains its verifier from a static connection. Callback dispatch and
  subscription lifecycle operations use
  [`resolveBinding`](../packages/eve/src/runtime/connections/events/dispatch-step.ts),
  which also searches only static connections.
- [Management actions](../packages/eve/src/runtime/connections/events/actions.ts)
  require a currently resolved connection. Removing an account can therefore
  remove the tool needed to stop its watch.

The existing [watch workflow](../packages/eve/src/runtime/connections/events/workflow.ts)
already saves its binding before subscribing, handles deliveries that arrive
before the subscribe response, and retries upstream cleanup. Extend that owner;
do not add a separate watch database or attach watch lifetime to a conversation.

## Delivery and recovery

```text
session resolver -> concrete connection -> saved watch -> Connect subscription
                                               |
verified webhook -> saved watch -> reconstruct exact connection -> callback
                                               |
                                       stop and cleanup
```

1. **Register a parameterized receiver.** Keep
   `POST /eve/v1/hooks/:connectionName`, including configured prefixes. Compile
   the route for agents with dynamic connection resolvers because returned
   connection names are unknown at build time. Validate route names and route
   conflicts, including namespaced extensions. Preserve static event handling.

2. **Verify before resolving user code.** Use Connect's existing delivery
   verification through an eve-owned boundary that does not need a live
   connection. Verify the actual destination path, then validate the echoed
   binding reference and load the saved watch. Do not invoke account resolvers
   or fetch an MCP URL based on an unverified request. Keep the verifier an
   optional integration; do not require every eve app to install Connect.

3. **Save reconstruction metadata with the watch.** Extend
   [`EventBinding`](../packages/eve/src/runtime/connections/events/state.ts)
   with a versioned reference to the authored resolver, its session scope, and
   the returned entry. Reuse compiler source identity and extension namespacing.
   Retain the resolver's trusted identity context and channel kind from its
   original evaluation, plus the watch creator's existing auth binding. Those
   identities can differ in a shared session; neither comes from webhook data.
   Persist only the required serializable metadata, never functions or OAuth
   credentials. Apply bounds consistent with existing durable context storage.

4. **Reconstruct and authorize the exact instance.** In a durable step, invoke
   only the referenced resolver with its saved resolution context. Select the
   saved entry, then check instance identity, connector, and the principal
   derived from the watch creator. Restore callbacks and the concrete provider
   together, preserving its scopes, subject mapping, and other Connect options.
   Do not substitute `connect(savedConnector)` for the original provider. A
   same-named static connection, another user's result, or the latest
   conversational caller must never become a fallback.

5. **Separate retry from retirement.** A thrown account lookup or temporary
   dependency failure retries through the existing durable workflow policy;
   it is not evidence of account removal. A successful resolution returning
   `null`, a missing entry, or a changed instance disables callback execution
   and retires that watch. Missing authored code after a deploy has the same
   outcome. Trace the reason without logging credentials or event payloads.
   Do not invoke a replacement connection's `onTerminated` as a fallback.

Recovery reruns a resolver without emitting a new session lifecycle event or
rebuilding the session's conversational registry. Resolvers must be idempotent.
Callbacks retain the existing retry contract: they can execute again after a
crash and must deduplicate effects using `deliveryId`.

## Stopping a removed connection

Callback reconstruction must not be required to disable delivery. Extend watch
management to authorize the saved owner by watch ID even when its connection is
absent from the current registry. Prefer retaining the existing qualified
get/stop action names, with a management-only resolution path; do not resurrect
the removed connection's catalog, tools, or subscribe action.

Stopping must durably mark the watch as stopping before cleanup begins. New
deliveries must then be rejected and queued deliveries must check that state
before invoking callbacks. A callback already executing may finish. Keep the
cleanup owner available for retries and distinguish stopping from complete.

Upstream cleanup is a separate design gate. The current backend exposes live
`createAdapter` and `verify` functions, not a durable management descriptor.
Before implementing, confirm how get/unsubscribe can use the original
subscription's saved authorization scope without resolving the deleted account.
Prefer a small serializable management binding containing non-secret Connect
subject/scope information, with fresh project authorization at execution.
Do not persist access tokens or reconstruct a provider with default options.

If the existing SDK cannot expose that binding safely, propose the smallest
Connect bridge addition separately. Until upstream cleanup succeeds, report it
as pending and preserve retries; local stopping must still work. No AI SDK or
MCP protocol change is expected.

## Implementation sequence and validation

1. Settle verifier loading and the cleanup binding. Prove a removed account's
   watch can stop without executing its resolver or exposing credentials.
2. Carry resolver provenance and saved resolution context into event bindings.
   Enable event callbacks for session-scoped dynamic results with a concrete
   Connect provider. Keep unsupported scopes and auth resolvers explicit errors.
3. Add parameterized routing and recovery to subscribe, dispatch, and lifecycle
   operations. Reuse the existing early-delivery and idempotency behavior.
4. Add management independent of the active connection registry, with durable
   stopping, cleanup retries, and trace coverage for reconstruction outcomes.
5. Update the MCP and dynamic connection docs and add a patch changeset when
   runtime support ships. Check extension contracts if exported types change.

Cover these behaviors at the narrowest existing test boundary:

| Boundary                | Required cases                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definition and identity | Single/map results, stable account identity, unsupported scopes, auth resolver rejection, extension namespaces.                                                                                |
| Receiver and watch      | Verified delivery; wrong path or subscription rejected; early delivery waits for the subscribe result; ended watch returns `410`.                                                              |
| Recovery and isolation  | Cold process/redeploy; two users with the same connection name; creator differs from session initiator/latest caller; changed URL, connector, or account never runs a replacement callback.    |
| Lifecycle               | Resolver throws then recovers; removed entry retires; stop works without the connection; queued delivery observes stopping; cleanup preserves custom subject/scopes and retries after failure. |
| Existing behavior       | Static events, duplicate delivery/replayed callback, expiry, gap, termination, and existing subscribe idempotency remain covered.                                                              |
| Built application       | Parameterized receiver survives bundling with prefixes and no static event connection; deterministic fixture eval subscribes, delivers, and stops.                                             |

Use scoped unit/integration tests locally and a build-backed route scenario.
Run the deterministic fixture eval in CI; use no real Bird credentials.
Avoid unit tests that merely mirror the implementation's internal objects.

## Related proposals and review decisions

- [Dynamic capabilities with functions and memos (#4616)](https://github.com/vercel/eve/pull/4616)
  proposes replacing lifecycle maps. This example targets current main. If that
  lands first, adapt authoring and reconstruction to its evaluator and persisted
  observations instead of building another lifecycle-specific recovery system.
- [Subscriptions as one primitive (#5164)](https://github.com/vercel/eve/pull/5164)
  proposes sharing ownership across schedules, connection events, and channel
  events. Reuse that owner if it lands first. This proposal only adds dynamic
  connection support; it does not introduce another subscription primitive.

Review the initial session-only scope, whether qualified get/stop actions are
sufficient when a connection disappears, and the cleanup binding's exact
contract before implementation. Shared callbacks are the supported authoring
contract, not a promise that arbitrary closures can be serialized or recovered.
