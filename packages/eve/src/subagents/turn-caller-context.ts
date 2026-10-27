import { CHANNEL_CONTEXT_KEY_NAME, SESSION_CALLBACK_CONTEXT_KEY_NAME } from "#context/key-names.js";
import type { TurnCaller } from "#channel/types.js";
import {
  isSubagentAdapterState,
  SUBAGENT_ADAPTER_KIND,
  type SubagentAdapterState,
} from "#subagents/adapter-state.js";

/**
 * Points child event forwarding at the caller that owns the next accepted turn,
 * so the turn's input requests and progress reach that caller and not the
 * previous one.
 */
export function bindTurnCallerContext(
  caller: TurnCaller | undefined,
  serializedContext: Record<string, unknown>,
): Record<string, unknown> {
  if (caller === undefined) return serializedContext;
  if (caller.replyTo.kind === "callback") {
    const callback = {
      callId: caller.callId,
      subagentName: caller.subagentName,
      token: caller.replyTo.token,
      url: caller.replyTo.url,
    };
    return { ...serializedContext, [SESSION_CALLBACK_CONTEXT_KEY_NAME]: callback };
  }

  const adapter = serializedContext[CHANNEL_CONTEXT_KEY_NAME];
  if (
    adapter === null ||
    typeof adapter !== "object" ||
    Reflect.get(adapter, "kind") !== SUBAGENT_ADAPTER_KIND ||
    !isSubagentAdapterState(Reflect.get(adapter, "state"))
  ) {
    throw new Error("Delegated local turn is missing its subagent adapter binding.");
  }
  const state = Reflect.get(adapter, "state") as SubagentAdapterState;
  const nextState: SubagentAdapterState = {
    ...state,
    callId: caller.callId,
    parentContinuationToken: caller.replyTo.token,
    subagentName: caller.subagentName,
  };
  return {
    ...serializedContext,
    [CHANNEL_CONTEXT_KEY_NAME]: {
      ...adapter,
      state: nextState,
    },
  };
}
