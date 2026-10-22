import { storedProjection } from "#harness/session-machine/view.js";
import type { SessionStateMap } from "#harness/types.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { addTokenUsage, usageSince } from "#shared/token-usage-math.js";
import type { TokenUsage } from "#shared/token-usage.js";

const REPORTED_SESSION_USAGE_STATE_KEY = "eve.harness.reportedSessionUsage";
const SESSION_USAGE_WINDOW_START_KEY = "eve.harness.sessionUsageWindowStart";
const SESSION_USAGE_WINDOW_INDEX_KEY = "eve.harness.sessionUsageWindowIndex";

export const NO_USAGE: TokenUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/** Lifetime spend comes only from committed usage facts, including delegated spend. */
export function sessionUsage(session: { readonly state?: SessionStateMap }): TokenUsage {
  return storedProjection(session.state).view.usage.total;
}

/** Own model runs include summaries; delegated spend belongs to the calls that delegated. */
export function turnUsage(view: SessionView, turnId: string): TokenUsage {
  let total = NO_USAGE;
  for (const run of Object.values(view.runs)) {
    if (run.usage === undefined) continue;
    const { owner } = run;
    const turn = "turnId" in owner ? owner.turnId : view.changes[owner.changeId]?.turnId;
    if (turn === turnId) total = addTokenUsage(total, run.usage);
  }
  return total;
}

/** The current step can supply its live, committed view before the state snapshot is saved. */
export function getSessionUsageWindow(
  session: { readonly state?: SessionStateMap },
  total = sessionUsage(session),
): TokenUsage {
  return usageSince(
    total,
    session.state?.[SESSION_USAGE_WINDOW_START_KEY] as TokenUsage | undefined,
  );
}

export function getSessionUsageWindowIndex(session: { readonly state?: SessionStateMap }): number {
  return (session.state?.[SESSION_USAGE_WINDOW_INDEX_KEY] as number | undefined) ?? 0;
}

/** A continuation changes the window, never the lifetime facts or child reporting cursor. */
export function resetSessionUsageWindow<T extends { readonly state?: SessionStateMap }>(
  session: T,
  total = sessionUsage(session),
): T {
  return {
    ...session,
    state: {
      ...session.state,
      [SESSION_USAGE_WINDOW_START_KEY]: total,
      [SESSION_USAGE_WINDOW_INDEX_KEY]: getSessionUsageWindowIndex(session) + 1,
    },
  };
}

/** A persistent child reports each committed unit of spend to its parent exactly once. */
export function takeSessionUsageDelta<T extends { readonly state?: SessionStateMap }>(
  session: T,
): { readonly delta: TokenUsage; readonly session: T } {
  const total = sessionUsage(session);
  return {
    delta: usageSince(total, reportedUsage(session.state)),
    session: withReported(session, total),
  };
}

/** Spend outside a turn must not be claimed again by a later turn's report. */
export function markUsageReported<T extends { readonly state?: SessionStateMap }>(
  session: T,
  usage: TokenUsage,
): T {
  return withReported(session, addTokenUsage(reportedUsage(session.state), usage));
}

export function withModelUsage(view: SessionView, usage: TokenUsage): SessionView {
  return { ...view, usage: { byKind: { model: usage }, total: usage } };
}

function reportedUsage(state: SessionStateMap | undefined): TokenUsage {
  return (state?.[REPORTED_SESSION_USAGE_STATE_KEY] as TokenUsage | undefined) ?? NO_USAGE;
}

function withReported<T extends { readonly state?: SessionStateMap }>(
  session: T,
  usage: TokenUsage,
): T {
  return { ...session, state: { ...session.state, [REPORTED_SESSION_USAGE_STATE_KEY]: usage } };
}
