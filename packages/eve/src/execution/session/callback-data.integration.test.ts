import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { afterEach, expect, it, vi } from "vitest";

import { createSession } from "#channel/session.js";
import { SessionCallbackKey } from "#context/keys.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { defineState, setCallbackData } from "#public/context/index.js";
import { defineHook } from "#public/definitions/hook.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("delivers a turn's committed callback data across a transport retry, then its receipt", async () => {
  const agentName = "callback-data";
  const callback = {
    callId: "report-call",
    subagentName: "reporter",
    token: "report-token",
    url: "https://consumer.example/eve/v1/callback/report-token",
  };
  const bodies: Record<string, unknown>[] = [];
  const acknowledged = Promise.withResolvers<void>();
  const fetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) !== callback.url) return fetch(url, options);
      bodies.push(JSON.parse(String(options?.body)) as Record<string, unknown>);
      // The first delivery fails in transport: the retry must carry the same report.
      if (bodies.length === 1) return new Response(null, { status: 503 });
      acknowledged.resolve();
      return new Response(null, { status: 200 });
    }),
  );
  const steps = defineState("callback-data.steps", () => 0);
  let modelRuns = 0;
  let callerlessError: unknown;

  const runtime = await createTestRuntime({
    agent: { name: agentName },
    modules: [
      {
        logicalPath: "hooks/report.ts",
        loadNamespace: async () => ({
          default: defineHook({
            events: {
              "model.settled"() {
                modelRuns += 1;
                steps.update((count) => count + 1);
              },
              "turn.settled"(event) {
                if (event.data.turnId === "turn_0") {
                  setCallbackData({ cost: "0.0007", steps: steps.get() });
                  return;
                }
                try {
                  setCallbackData({ outcome: "callerless" });
                } catch (error) {
                  callerlessError = error;
                }
              },
            },
          }),
        }),
      },
    ],
  });
  const workflowRuntime = createWorkflowRuntime({
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
  });

  await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Alice requests a short greeting." },
        serializedContext: {
          ...buildSerializedContext({
            channelKind: "http",
            continuationToken: `http:${agentName}`,
          }),
          [SessionCallbackKey.name]: callback,
        },
      },
    ]);
    const stream = captureTurnEvents(run);
    const session = createSession(run.runId, workflowRuntime);
    try {
      await stream.nextTurn();
      await acknowledged.promise;
      const receipt = await stream.nextUntil((event) => event.type === "callback.delivered");
      expect(receipt.at(-1)?.data).toEqual({ callId: callback.callId });

      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[1]).toMatchObject({
        applicationData: { cost: "0.0007", steps: 1 },
        callId: callback.callId,
        kind: "turn.completed",
      });
      // The retried notification did not run the model again.
      expect(modelRuns).toBe(1);

      // A later turn nobody waits on by callback has no report to set, and delivers none.
      await session.send("Bob asks for another greeting.", { auth: null });
      await stream.nextTurn();
      expect(callerlessError).toMatchObject({
        message: "This turn has no native completion callback.",
      });
      expect(bodies).toHaveLength(2);
    } finally {
      stream.dispose();
    }
  });
}, 60_000);
