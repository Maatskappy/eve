import { getSubscription } from "#compiled/@vercel/connect-events/index.js";
import { loadContext } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import {
  EVENT_WATCH_GET_TOOL_NAME,
  EVENT_WATCH_STOP_TOOL_NAME,
} from "#protocol/event-watch-tools.js";
import { principalOf } from "#execution/session/principal.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { defineJsonSchema } from "#tools/schema.js";
import { withConnectionEventSpan } from "#tracing/eve/connection-events.js";

/** Creator-authorized housekeeping, independent of the current connection catalog. */
export function connectionEventManagementEntry(name: string): HarnessToolDefinition | undefined {
  if (name !== EVENT_WATCH_GET_TOOL_NAME && name !== EVENT_WATCH_STOP_TOOL_NAME) return undefined;
  return {
    name,
    deferred: true,
    rootOnly: true,
    description:
      "Inspect or stop a dynamic event watch owned by the current caller, using its saved watch id.",
    inputSchema: defineJsonSchema({
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string", pattern: "^[a-f0-9]{64}$" } },
    }),
    async execute(input) {
      const { findConnectionEventOwner, retireConnectionEventOwner } =
        await import("#runtime/connections/events/owner.js");
      const ctx = loadContext();
      const { id } = input as { id: string };
      const watch = await findConnectionEventOwner(id);
      if (
        ctx.require(BundleKey).nodeId !== undefined ||
        watch === undefined ||
        watch.owner.resolution === undefined ||
        watch.owner.executionPrincipal !== principalOf(ctx.get(AuthKey))
      )
        throw new Error("Unknown subscription for this caller and account.");
      const connectionName = watch.owner.connectionName;
      if (name === EVENT_WATCH_STOP_TOOL_NAME) {
        if (!(await retireConnectionEventOwner(id)))
          throw new Error("Unknown subscription for this caller and account.");
        return { id, status: "stopping" };
      }
      if (watch.stopping) return { id, status: "stopping", cleanupStatus: "pending" };
      if (watch.subscription === undefined) return { id, status: "pending" };
      const subscription = await withConnectionEventSpan(
        {
          ctx,
          connectionName,
          bindingId: id,
          subscriptionId: watch.subscription.id,
          operation: "get",
        },
        () =>
          getSubscription(
            watch.owner.connector,
            { id: watch.subscription!.id },
            { timeout: 30_000 },
          ),
      );
      return { ...subscription, id, subscriptionId: subscription.id };
    },
  };
}
