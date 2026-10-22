import {
  createSessionLimitContinuationRequest,
  type LimitAsk,
  toJsonUsage,
} from "#harness/hitl/budget-request.js";
import { getSessionUsageWindow, getSessionUsageWindowIndex } from "#harness/session-usage.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionUsageLimit } from "#shared/agent-definition.js";
import type { JsonObject } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** Cache reads replay history rather than spending new input. Cache writes still count. */
export const DEFAULT_SESSION_USAGE_LIMIT: SessionUsageLimit = ({ window }) =>
  window.inputTokens - window.cacheReadTokens >= 40_000_000;

export type SessionUsageLimitCheck =
  | { readonly kind: "within" }
  | { readonly kind: "ask"; readonly ask: LimitAsk }
  | {
      readonly kind: "fail";
      readonly code: string;
      readonly details: JsonObject;
      readonly message: string;
    };

export function checkSessionUsageLimit(input: {
  readonly canAsk: boolean;
  readonly limit: SessionUsageLimit;
  readonly session: Pick<HarnessSession, "sessionId" | "state">;
  readonly turnSequence: number;
  readonly usage: TokenUsage;
}): SessionUsageLimitCheck {
  const total = input.usage;
  const window = getSessionUsageWindow(input.session, total);
  if (
    (window.inputTokens === 0 && window.outputTokens === 0 && !window.costUsd) ||
    !input.limit({ total: { ...total }, window: { ...window } })
  )
    return { kind: "within" };
  if (input.canAsk)
    return {
      kind: "ask",
      ask: createSessionLimitContinuationRequest({
        sessionId: input.session.sessionId,
        turnSequence: input.turnSequence,
        windowIndex: getSessionUsageWindowIndex(input.session),
      }),
    };
  return {
    kind: "fail",
    code: "SESSION_USAGE_LIMIT_REACHED",
    details: { total: toJsonUsage(total), window: toJsonUsage(window) },
    message: "The session reached its usage limit.",
  };
}
