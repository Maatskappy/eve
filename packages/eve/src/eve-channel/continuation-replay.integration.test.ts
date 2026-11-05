import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { createSession } from "#channel/session.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { eveChannel } from "#public/channels/eve.js";
import { httpBasic } from "#public/channels/auth.js";
import { sessionHookPumpWorkflow } from "#internal/testing/session-hook-pump-workflow.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import {
  waitForParkedTurnStep,
  readTurnStepStates,
} from "#internal/testing/session-test-helpers.js";
import { waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";

function routeCaller(acceptedDeploymentId?: string) {
  const channel = eveChannel({
    trustedForwarders: () => true,
    auth: [
      httpBasic({ username: "alice", password: "test" }),
      httpBasic({ username: "bob", password: "test" }),
    ],
  });
  const route = channel.routes!.find(
    (route) => route.method === "POST" && route.path === "/eve/v1/session/:sessionId",
  )!;
  const runtime = createWorkflowRuntime({
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
  });
  return async (sessionId: string, body: unknown, caller: string | false = "alice") => {
    const args = {
      ...mockAgentRouteArgs(),
      ...mockChannelContext(() => {
        throw new Error("Unexpected channel delivery");
      }),
      attachSession: (id: string) =>
        createSession(id, runtime, {
          channelKind: "eve",
          channelName: "eve",
          acceptedDeploymentId,
        }),
      to: () => {
        throw new Error("Unexpected channel target");
      },
      params: { sessionId },
      requestIp: "127.0.0.1",
      waitUntil: () => undefined,
    } satisfies RouteHandlerArgs;
    const headers = new Headers({ "content-type": "application/json" });
    if (caller !== false) headers.set("authorization", `Basic ${btoa(`${caller}:test`)}`);
    return await (route.handler as (request: Request, args: RouteHandlerArgs) => Promise<Response>)(
      new Request(`https://example.com/eve/v1/session/${sessionId}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers,
      }),
      args,
    );
  };
}

describe("authenticated continuation replay", () => {
  it("recovers an encrypted operation interrupted after its actual local claim reservation", async () => {
    const world = await getWorld();
    const originalEncryptionKey = world.getEncryptionKeyForRun;
    world.getEncryptionKeyForRun = async () => new Uint8Array(32).fill(7);
    const run = await start(sessionHookPumpWorkflow, [
      { aliases: [], releaseToken: "replay:interrupted" },
    ]);
    const send = routeCaller();
    const body = { operationId: "interrupted-answer", message: "Use the blue option" };
    const link = fs.link.bind(fs);
    let interrupt = true;
    let claimPath: string | undefined;
    const linked = vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
      const target = String(destination);
      if (target.includes("/hooks/resumes/")) {
        const claim = JSON.parse(await fs.readFile(source, "utf8")) as { runId: string };
        if (claim.runId === run.runId) claimPath = target;
      }
      if (interrupt && target.includes(`/events/${run.runId}-`)) {
        const event = JSON.parse(await fs.readFile(source, "utf8")) as { resumeId?: string };
        if (event.resumeId)
          throw new Error("Interrupted after claim reservation before event publication");
      }
      return await link(source, destination);
    });
    try {
      await waitForHook(run, { token: sessionInboxHookToken(sessionCommandHookToken(run.runId)) });
      expect((await send(run.runId, body)).status).toBe(500);
      expect(claimPath).toBeDefined();
      const originalClaim = await fs.readFile(claimPath!, "utf8");
      const claim = JSON.parse(originalClaim) as {
        resumeId: string;
        payloadDigest: string;
        evePayload: string;
      };
      expect(claim.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
      const events = await world.events.list({ runId: run.runId, resolveData: "all" });
      expect(events.data.filter((event) => event.eventType === "hook_received")).toHaveLength(0);
      interrupt = false;
      // Readback must validate the exact bytes, not merely trust logical metadata.
      await fs.writeFile(claimPath!, JSON.stringify({ ...claim, evePayload: "AA==" }));
      expect((await send(run.runId, body)).status, "corrupt reserved bytes fail closed").toBe(500);
      await fs.writeFile(claimPath!, originalClaim);
      const [retry, changed] = await Promise.all([
        send(run.runId, body),
        send(run.runId, { ...body, message: "Use the red option" }),
      ]);
      expect(retry.status, "identical encrypted retry recovers the reserved claim").toBe(202);
      expect(changed.status, "changed payload cannot take over the reserved claim").toBe(409);
      const receipt = await retry.json();
      expect(receipt).toMatchObject({
        sessionId: run.runId,
        operationId: body.operationId,
        deliveryId: claim.resumeId,
      });
      expect(await (await send(run.runId, body)).json()).toEqual(receipt);
      expect((await send(run.runId, { ...body, message: "Use the red option" })).status).toBe(409);
      await resumeHook("replay:interrupted", undefined);
      expect(await run.returnValue, "one command survives interrupted admission").toHaveLength(1);
      expect(JSON.parse(await fs.readFile(claimPath!, "utf8")).evePayload).toBeUndefined();
    } finally {
      linked.mockRestore();
      if ((await run.status) === "running") await run.cancel();
      world.getEncryptionKeyForRun = originalEncryptionKey;
    }
  });

  it("purges an interrupted local claim payload when a zero-retention run ends", async () => {
    const run = await start(
      sessionHookPumpWorkflow,
      [{ aliases: [], releaseToken: "replay:purged-claim" }],
      { experimental_retention: 0 },
    );
    const send = routeCaller();
    const link = fs.link.bind(fs);
    let claimPath: string | undefined;
    const linked = vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
      const target = String(destination);
      if (target.includes("/hooks/resumes/")) {
        const claim = JSON.parse(await fs.readFile(source, "utf8")) as { runId: string };
        if (claim.runId === run.runId) claimPath = target;
      }
      if (target.includes(`/events/${run.runId}-`)) {
        const event = JSON.parse(await fs.readFile(source, "utf8")) as { resumeId?: string };
        if (event.resumeId) throw new Error("Interrupted before event publication");
      }
      return await link(source, destination);
    });
    try {
      await waitForHook(run, { token: sessionInboxHookToken(sessionCommandHookToken(run.runId)) });
      expect(
        (await send(run.runId, { operationId: "purged-answer", message: "Private answer" })).status,
      ).toBe(500);
      expect(claimPath).toBeDefined();
      expect(JSON.parse(await fs.readFile(claimPath!, "utf8")).evePayload).toEqual(
        expect.any(String),
      );
      await run.cancel();
      expect(JSON.parse(await fs.readFile(claimPath!, "utf8")).evePayload).toBeUndefined();
    } finally {
      linked.mockRestore();
      if ((await run.status) === "running") await run.cancel();
    }
  });

  it("admits concurrent copies once and replays the accepted receipt after completion", async () => {
    const world = await getWorld();
    const originalEncryptionKey = world.getEncryptionKeyForRun;
    world.getEncryptionKeyForRun = async () => new Uint8Array(32).fill(7);
    const run = await start(sessionHookPumpWorkflow, [
      { aliases: [], releaseToken: "replay:release" },
    ]);
    const send = routeCaller();
    const body = { operationId: "answer-1", message: "Use the blue option" };
    const bothAdmitting = Promise.withResolvers<void>();
    let admissions = 0;
    const createEvent = world.events.create.bind(world.events);
    const created = vi.spyOn(world.events, "create").mockImplementation(async (...args) => {
      if (args[0] === run.runId && args[1].eventType === "hook_received" && admissions < 2) {
        if (++admissions === 2) bothAdmitting.resolve();
        await bothAdmitting.promise;
      }
      return await createEvent(...args);
    });
    try {
      await waitForHook(run, { token: sessionInboxHookToken(sessionCommandHookToken(run.runId)) });
      const responses = await Promise.all([send(run.runId, body), send(run.runId, body)]);
      expect(responses.map((response) => response.status)).toEqual([202, 202]);
      const receipts = await Promise.all(responses.map((response) => response.json()));
      expect(receipts[0]).toMatchObject({
        operationId: body.operationId,
        sessionId: run.runId,
        status: "accepted",
        deliveryId: expect.any(String),
      });
      expect(receipts[1]).toEqual(receipts[0]);
      // The first response is discarded by the client; a fresh request must recover it.
      expect(await (await send(run.runId, body)).json()).toEqual(receipts[0]);
      expect((await send(run.runId, { ...body, message: "Use the red option" })).status).toBe(409);
      expect((await send(run.runId, body, false)).status).toBe(401);
      await resumeHook("replay:release", undefined);
      const commands = await run.returnValue;
      expect(commands, "one admitted command is consumed").toHaveLength(1);
      expect(await (await send(run.runId, body)).json()).toEqual(receipts[0]);
      expect((await send(run.runId, { ...body, message: "Changed after completion" })).status).toBe(
        409,
      );
    } finally {
      created.mockRestore();
      if ((await run.status) === "running") await run.cancel();
      world.getEncryptionKeyForRun = originalEncryptionKey;
    }
  });
  it("keeps caller and session operation identities separate and repairs a lost wake response", async () => {
    const first = await start(sessionHookPumpWorkflow, [
      { aliases: [], releaseToken: "replay:isolation:first" },
    ]);
    const second = await start(sessionHookPumpWorkflow, [
      { aliases: [], releaseToken: "replay:isolation:second" },
    ]);
    const send = routeCaller();
    const body = { operationId: "same-id", message: "Alice confirms the plan" };
    const world = await getWorld();
    const queue = world.queue.bind(world);
    let loseResponse = true;
    const queued = vi.spyOn(world, "queue").mockImplementation(async (...args) => {
      const result = await queue(...args);
      if (loseResponse && (args[1] as { runId?: string }).runId === first.runId) {
        loseResponse = false;
        throw new Error("Lost queue response after durable admission");
      }
      return result;
    });
    try {
      await Promise.all(
        [first, second].map((run) =>
          waitForHook(run, { token: sessionInboxHookToken(sessionCommandHookToken(run.runId)) }),
        ),
      );
      expect((await send(first.runId, body)).status).toBe(500);
      const alice = (await (await send(first.runId, body)).json()) as { deliveryId: string };
      const bob = (await (
        await send(first.runId, { ...body, message: "Bob confirms his plan" }, "bob")
      ).json()) as { deliveryId: string };
      const otherSession = (await (await send(second.runId, body)).json()) as {
        deliveryId: string;
      };
      expect(new Set([alice.deliveryId, bob.deliveryId, otherSession.deliveryId]).size).toBe(3);
      const forwarded = await Promise.all(
        ["tenant-a", "tenant-b"].map((principalId) =>
          send(first.runId, {
            ...body,
            forwardedPrincipal: {
              current: {
                attributes: {},
                authenticator: "trusted-forwarder",
                principalId,
                principalType: "user",
              },
            },
          }).then(async (response) => (await response.json()) as { deliveryId: string }),
        ),
      );
      expect(
        new Set([alice.deliveryId, ...forwarded.map((receipt) => receipt.deliveryId)]).size,
      ).toBe(3);
      expect((await send(first.runId, { message: "Ordinary follow-up" })).status).toBe(202);
      expect((await send(first.runId, { message: "Ordinary follow-up" })).status).toBe(202);
      await resumeHook("replay:isolation:first", undefined);
      await resumeHook("replay:isolation:second", undefined);
      expect(await first.returnValue).toHaveLength(6);
      expect(await second.returnValue).toHaveLength(1);
      expect(await (await send(first.runId, body, "bob")).json()).toMatchObject({
        code: "operation_conflict",
      });
    } finally {
      queued.mockRestore();
      for (const run of [first, second]) if ((await run.status) === "running") await run.cancel();
    }
  });

  it("replays predecessor and successor receipts through the real session handoff after completion", async () => {
    const testRuntime = await createTestRuntime({ agent: { name: "continuation-replay-handoff" } });
    await testRuntime.run(async () => {
      const anchor = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_a",
          sessionTimeoutMs: false,
          input: { message: "Alice opens a planning session." },
          serializedContext: buildSerializedContext({
            acceptedDeploymentId: "dpl_a",
            channelKind: "http",
          }),
        },
      ]);
      const stream = captureTurnEvents(anchor);
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const send = routeCaller("dpl_c");
      const first = { operationId: "before-handoff", message: "Alice chooses the blue option." };
      const second = { operationId: "after-handoff", message: "Alice approves the final plan." };
      try {
        await stream.nextTurn();
        await waitForParkedTurnStep(anchor.runId);
        // Existing sessions may already have changed owners before this API was deployed.
        expect(
          (
            await routeCaller("dpl_b")(anchor.runId, {
              message: "Alice continues the existing plan.",
            })
          ).status,
        ).toBe(202);
        await stream.nextTurn();
        const previousOwner = await waitForCommandHookOwner(
          sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
        );
        expect(previousOwner.runId).not.toBe(anchor.runId);
        await waitForParkedTurnStep(previousOwner.runId);
        const world = await getWorld();
        const writeStream = world.streams.write.bind(world.streams);
        const indexed = vi.spyOn(world.streams, "write").mockImplementation(async (...args) => {
          if (args[1] === `${anchor.runId}_eve-continuation-owners`)
            throw new Error("Owner index unavailable before admission");
          await writeStream(...args);
        });
        try {
          expect((await send(anchor.runId, first)).status).toBe(500);
        } finally {
          indexed.mockRestore();
        }
        const firstResponse = await send(anchor.runId, first);
        expect(firstResponse.status).toBe(202);
        const firstReceipt = await firstResponse.json();
        await stream.nextTurn();
        const owner = await waitForCommandHookOwner(
          sessionInboxHookToken(sessionCommandHookToken(anchor.runId)),
        );
        expect(owner.runId).not.toBe(anchor.runId);
        expect(owner.runId).not.toBe(previousOwner.runId);
        await waitForParkedTurnStep(owner.runId);
        expect(await (await send(anchor.runId, first)).json()).toEqual(firstReceipt);
        const secondReceipt = await (await send(anchor.runId, second)).json();
        await stream.nextTurn();
        await waitForParkedTurnStep(owner.runId, 2);
        await runtime.dispatchSession({ sessionId: anchor.runId, command: { kind: "reset" } });
        await anchor.returnValue;
        const getChunks = world.streams.getChunks.bind(world.streams);
        const paginated = vi
          .spyOn(world.streams, "getChunks")
          .mockImplementation((runId, name, options) =>
            getChunks(runId, name, { ...options, limit: 1 }),
          );
        try {
          expect(await (await send(anchor.runId, first)).json()).toEqual(firstReceipt);
          expect(await (await send(anchor.runId, second)).json()).toEqual(secondReceipt);
        } finally {
          paginated.mockRestore();
        }
        const states = await readTurnStepStates(owner.runId);
        const history = states.find((state) =>
          JSON.stringify(state.history).includes(second.message),
        )!.history;
        for (const message of [first.message, second.message]) {
          expect(
            history.filter(
              (item) => item.role === "user" && JSON.stringify(item.content).includes(message),
            ),
          ).toHaveLength(1);
        }
      } finally {
        stream.dispose();
        await runtime.dispatchSession({ sessionId: anchor.runId, command: { kind: "reset" } });
        if ((await anchor.status) === "running") await anchor.cancel();
      }
    });
  });
});
