import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionCallbackKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { callbackDataProperties } from "#context/callback-data.js";
import { setCallbackData } from "#public/definitions/callback-data.js";
import {
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
} from "#subagents/parent-notification.js";

const callback = {
  callId: "turn-call",
  subagentName: "reporter",
  token: "signed-callback",
  url: "https://consumer.example/eve/v1/callback/signed-callback",
};
const caller = {
  callId: callback.callId,
  subagentName: callback.subagentName,
  replyTo: { kind: "callback" as const, token: callback.token, url: callback.url },
};
const report = { receipts: [{ id: "provider-step", cost: "0.0007" }], outcome: "completed" };

describe("authored completion callback data", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("requires a managed turn with a native callback", () => {
    expect(() => setCallbackData(report)).toThrow(/No active eve context/);
    contextStorage.run(new ContextContainer(), () =>
      expect(() => setCallbackData(report)).toThrow(/no native completion callback/),
    );
  });
  it.each(["completed", "failed", "cancelled"] as const)(
    "preserves the authored JSON in the %s notification envelope",
    async (outcome) => {
      const ctx = new ContextContainer();
      ctx.set(SessionCallbackKey, callback);
      contextStorage.run(ctx, () => setCallbackData(report));
      const committed = JSON.parse(JSON.stringify(serializeContext(ctx)));
      const calls: unknown[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, options) => {
          calls.push(JSON.parse(options.body));
          return new Response(null, { status: calls.length === 1 ? 503 : 200 });
        }),
      );
      const notify = () =>
        outcome === "cancelled"
          ? notifyCancelledTaskCallerStep({
              caller,
              sessionId: "session",
              ...callbackDataProperties(committed, caller.callId),
            })
          : notifyTurnCallerStep({
              caller,
              sessionId: "session",
              lifecycle: "terminal",
              settled: {
                output: "original output",
                isError: outcome === "failed",
              },
              ...callbackDataProperties(committed, caller.callId),
            });
      await expect(notify()).rejects.toThrow(/HTTP 503/);
      await notify();
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]);
      expect(calls[1]).toMatchObject({ callId: callback.callId, applicationData: report });
      expect(callbackDataProperties(committed, "different-call")).toEqual({});
    },
  );
});
