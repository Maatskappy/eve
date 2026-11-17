import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { afterEach, expect, it, vi } from "vitest";

import { createSession } from "#channel/session.js";
import { SessionCallbackKey } from "#context/keys.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { defineDynamic } from "#dynamic/definition.js";
import { mockModel } from "#evals/mock-model.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import { schemaViolation } from "#protocol/session-events/schemas.js";
import type { Fact } from "#protocol/session-events/facts.js";
import type { StoredLine } from "#protocol/session-events/envelope.js";
import { NOT_PENDING_RETRY_DELAYS_MS } from "#subagents/parent-notification.js";
import { defineAgent } from "#public/definitions/agent.js";
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

/** Drive the real session owner through each notification boundary, retaining its whole stream. */
async function callbackSession(
  mode: "completed" | "cancelled" | "terminal",
  acknowledged: boolean,
) {
  const callback = {
    callId: "boundary-call",
    subagentName: "reporter",
    token: "boundary-token",
    url: "https://consumer.example/eve/v1/callback/boundary-token",
  };
  const bodies: Record<string, unknown>[] = [];
  const firstAttempt = Promise.withResolvers<void>();
  const exhausted = Promise.withResolvers<void>();
  const fetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url) !== callback.url) return fetch(url, options);
      bodies.push(JSON.parse(String(options?.body)) as Record<string, unknown>);
      if (bodies.length === NOT_PENDING_RETRY_DELAYS_MS.length + 1) exhausted.resolve();
      firstAttempt.resolve();
      return acknowledged
        ? new Response(null, { status: 200 })
        : Response.json(
            { code: "CALLBACK_NOT_PENDING", error: "Session callback not pending.", ok: false },
            { status: 404 },
          );
    }),
  );
  const dispatches = defineState("callback-boundary.dispatches", () => 0, { onCancel: "preserve" });
  const runtime = await createTestRuntime({
    agent: {
      name: `callback-${mode}`,
      definition: defineAgent({
        defaultTools: false,
        model: defineDynamic(() => ({
          model: mockModel(() => {
            if (mode === "terminal")
              throw Object.assign(new Error("Invalid API key"), { statusCode: 401 });
            return { text: "Hello.", usage: { inputTokens: 1, outputTokens: 1 } };
          }),
          modelContextWindowTokens: 200_000,
        })),
      }),
    },
    modules: [
      {
        logicalPath: "hooks/report.ts",
        loadNamespace: async () => ({
          default: defineHook({
            events: {
              "model.requested"(_event, ctx) {
                dispatches.update((value) => value + 1);
                if (mode === "cancelled") ctx.cancel();
              },
              "turn.settled"() {
                setCallbackData({ dispatches: dispatches.get() });
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
  return await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Alice requests a greeting." },
        serializedContext: {
          ...buildSerializedContext({
            channelKind: "http",
            continuationToken: `http:callback-${mode}`,
          }),
          [SessionCallbackKey.name]: callback,
        },
      },
    ]);
    const text = new Response(run.readable).text();
    // Observe expected terminal failure immediately, so it is never an unhandled rejection.
    let ownerError: unknown;
    const completed = run.returnValue.catch((error) => {
      ownerError = error;
    });
    try {
      await firstAttempt.promise;
      // Keep the workflow's own clock real: its durable leases and timers share this process.
      // The notifier's isolated tests use fake timers; this owner-boundary proof waits for exhaustion.
      if (!acknowledged) await exhausted.promise;
      if (mode !== "terminal")
        await createSession(run.runId, workflowRuntime).end({ reason: "Proof complete." });
      const lines = (await text)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as StoredLine);
      await completed;
      expect(ownerError).toBeUndefined();
      return { bodies, lines };
    } finally {
      await run.cancel().catch(() => undefined);
    }
  });
}

it.each(["completed", "cancelled", "terminal"] as const)(
  "does not publish a delivered receipt for an unacknowledged %s callback",
  async (mode) => {
    const { bodies, lines } = await callbackSession(mode, false);
    expect(bodies).toHaveLength(NOT_PENDING_RETRY_DELAYS_MS.length + 1);
    const facts = lines.flatMap((line) => ("facts" in line ? (line.facts as readonly Fact[]) : []));
    expect(facts.filter((fact) => fact.type === "callback.delivered")).toEqual([]);
    expect(facts.filter((fact) => fact.type === "session.ended")).toHaveLength(1);
    expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
  },
  60_000,
);

it("publishes a terminal receipt that validates with the entire closed session stream", async () => {
  const { bodies, lines } = await callbackSession("terminal", true);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ applicationData: { dispatches: 1 }, kind: "turn.failed" });
  const facts = lines.flatMap((line) => ("facts" in line ? (line.facts as readonly Fact[]) : []));
  expect(facts.at(-2)).toMatchObject({ type: "session.ended", data: { outcome: "failed" } });
  expect(facts.at(-1)).toMatchObject({
    type: "callback.delivered",
    data: { callId: "boundary-call" },
  });
  const checker = createStreamChecker({ validate: schemaViolation });
  expect(lines.flatMap((line, index) => checker.check(line, index))).toEqual([]);
  // The transport exception must not admit new session work after the end.
  expect(
    checker.check(
      {
        at: new Date().toISOString(),
        facts: [{ type: "delivery.admitted", data: { deliveryId: "late" } }],
      },
      lines.length,
    ),
  ).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "after-session-end" })]));
}, 60_000);

it("delivers cancellation data preserved from the cancelled batch", async () => {
  const { bodies, lines } = await callbackSession("cancelled", true);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ applicationData: { dispatches: 1 }, kind: "turn.failed" });
  const facts = lines.flatMap((line) => ("facts" in line ? (line.facts as readonly Fact[]) : []));
  expect(facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "turn.settled",
        data: expect.objectContaining({ outcome: "cancelled" }),
      }),
      expect.objectContaining({ type: "callback.delivered", data: { callId: "boundary-call" } }),
    ]),
  );
}, 60_000);
