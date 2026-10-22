import { describe, expect, it } from "vitest";
import {
  getSessionUsageWindow,
  getSessionUsageWindowIndex,
  markUsageReported,
  NO_USAGE,
  resetSessionUsageWindow,
  sessionUsage,
  takeSessionUsageDelta,
  turnUsage,
} from "#harness/session-usage.js";
import type { HarnessSession } from "#harness/types.js";
import { withSessionUsage } from "#internal/testing/session-usage.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";

function makeSession(): HarnessSession {
  return {
    agent: { modelReference: { id: "model_x" }, system: "", tools: [] },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "ct_test",
    history: [],
    sessionId: "alice",
  };
}
const spent = (inputTokens: number, outputTokens = 0) => ({
  ...NO_USAGE,
  inputTokens,
  outputTokens,
});

describe("what a session spent", () => {
  it("reads committed usage rather than maintaining a second counter", () => {
    expect(sessionUsage(makeSession())).toEqual(NO_USAGE);
    expect(sessionUsage(withSessionUsage(makeSession(), { inputTokens: 7 }))).toEqual(spent(7));
  });

  it("attributes own models and summaries to the turn, but not delegated spend", () => {
    const view = emptySessionView();
    const usage = (inputTokens: number) => ({ ...spent(inputTokens), costUsd: 0.01 });
    const facts: SessionEvent[] = [
      { data: {}, type: "session.started" },
      { data: { deliveryId: "d_1" }, type: "delivery.admitted" },
      {
        data: { cause: { deliveryId: "d_1" }, follows: null, turnId: "t_1" },
        type: "turn.started",
      },
      { data: { owner: { turnId: "t_1" }, runId: "r_1" }, type: "model.requested" },
      {
        data: { kind: "model", owner: { runId: "r_1" }, usage: usage(10) },
        type: "usage.recorded",
      },
      {
        data: {
          callId: "c_1",
          capability: { kind: "agent", name: "helper" },
          owner: { runId: "r_1" },
        },
        type: "call.requested",
      },
      {
        data: { kind: "model", owner: { callId: "c_1" }, usage: usage(500) },
        type: "usage.recorded",
      },
      { data: { changeId: "x_1", kind: "compaction", turnId: "t_1" }, type: "context.started" },
      { data: { owner: { changeId: "x_1" }, runId: "r_2" }, type: "model.requested" },
      { data: { kind: "model", owner: { runId: "r_2" }, usage: usage(5) }, type: "usage.recorded" },
    ];
    foldLine(view, { at: "2026-01-01T00:00:00.000Z", facts }, 0);
    expect(turnUsage(view, "t_1")).toEqual({ ...spent(15), costUsd: 0.02 });
    expect(view.usage.total.inputTokens).toBe(515);
  });
});

describe("usage windows", () => {
  it("anchors approval at the live committed total without changing lifetime usage or reporting", () => {
    const first = takeSessionUsageDelta(withSessionUsage(makeSession(), spent(10)));
    const reset = structuredClone(resetSessionUsageWindow(first.session, spent(35)));
    expect(getSessionUsageWindow(reset, spent(35))).toEqual({ ...spent(0), costUsd: undefined });
    expect(getSessionUsageWindowIndex(reset)).toBe(1);
    const later = withSessionUsage(reset, spent(45));
    expect(sessionUsage(later)).toEqual(spent(45));
    expect(getSessionUsageWindow(later)).toEqual({ ...spent(10), costUsd: undefined });
    expect(takeSessionUsageDelta(later).delta.inputTokens).toBe(35);
  });

  it("starts distinct cost-only windows even when token counts never change", () => {
    const session = withSessionUsage(makeSession(), { costUsd: 0.25 });
    const reset = resetSessionUsageWindow(session);
    const later = withSessionUsage(reset, { costUsd: 0.5 });
    expect(getSessionUsageWindow(later)).toMatchObject({ inputTokens: 0, costUsd: 0.25 });
    const second = resetSessionUsageWindow(later);
    expect(getSessionUsageWindowIndex(second)).toBe(2);
    expect(getSessionUsageWindow(second).costUsd).toBe(0);
    expect(sessionUsage(second).costUsd).toBe(0.5);
  });
});

describe("usage a child reports", () => {
  it("reports only new spend and distinguishes unknown cost from a reported cost", () => {
    const first = takeSessionUsageDelta(withSessionUsage(makeSession(), spent(10)));
    expect(first.delta).toEqual({ ...spent(10), costUsd: undefined });
    const later = withSessionUsage(first.session, { costUsd: 0.5, inputTokens: 30 });
    expect(takeSessionUsageDelta(later).delta).toEqual({ ...spent(20), costUsd: 0.5 });
  });

  it("does not claim compaction spend outside its turns twice", () => {
    const compacted = markUsageReported(withSessionUsage(makeSession(), spent(40)), spent(40));
    expect(takeSessionUsageDelta(withSessionUsage(compacted, spent(55))).delta.inputTokens).toBe(
      15,
    );
  });
});
