import { describe, expect, it } from "vitest";
import { SessionIdKey } from "#context/keys.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import { prepareRequestedSandboxStep } from "./readiness-step.js";

describe("sandbox readiness authorization", () => {
  it.each([false, true])(
    "refuses unshared runs even when they claim the owner (direct child: %s)",
    async (child) => {
      const runtime = await createTestRuntime();
      await runtime.run(async () => {
        const ownerId = "another-session";
        const started = await createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        }).createSession({
          adapter: { kind: child ? "subagent" : "http", state: {} },
          auth: null,
          input: { message: "Greet Alice briefly." },
          ...(child
            ? {
                parent: {
                  callId: "call-1",
                  rootSessionId: ownerId,
                  sessionId: ownerId,
                  turn: { id: "turn-0", sequence: 0 },
                },
              }
            : {}),
        });
        const stranger = getRun(started.sessionId);
        const stream = captureTurnEvents(stranger);
        try {
          await stream.nextTurn();
          const saved = await (await getWorld()).runs.get(stranger.runId, { resolveData: "none" });
          expect(saved.attributes?.["$eve.parent"]).toBe(child ? ownerId : undefined);
          const created = await createSessionStep({
            compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
            continuationToken: "",
            sessionId: ownerId,
          });
          for (const requesterSessionId of [stranger.runId, ownerId]) {
            const result = await prepareRequestedSandboxStep({
              serializedContext: {
                ...buildSerializedContext({ channelKind: "http" }),
                [SessionIdKey.name]: ownerId,
              },
              sessionState: created.state,
              sessionWritable: new WritableStream<Uint8Array>(),
              prepare: true,
              request: {
                kind: "sandbox-readiness",
                requesterSessionId,
                runId: stranger.runId,
                namespace: "eve.sandbox-ready:00000000-0000-4000-8000-000000000000",
              },
            });
            expect(result.reply).toBeUndefined();
            expect(result.stateDelta).toEqual({});
            expect(runtime.sandboxEvents).toEqual([]);
          }
        } finally {
          stream.dispose();
          await stranger.cancel();
        }
      });
    },
  );
});
