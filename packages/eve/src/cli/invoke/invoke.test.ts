import { expect, it, vi } from "vitest";
import { resolveInvokeOperation, runInvoke } from "#cli/invoke/invoke.js";
import { stampTestEvents } from "#internal/testing/events.js";
import type { SessionEvent } from "#protocol/session-event.js";

const { attach, resolveClient } = vi.hoisted(() => ({ attach: vi.fn(), resolveClient: vi.fn() }));
vi.mock("#client/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#client/index.js")>();
  return {
    ...original,
    Client: class {
      sessions = { attach };
    },
  };
});
vi.mock("#setup/verified-remote-client.js", () => ({
  resolveVerifiedRemoteDevelopmentClient: resolveClient,
}));
import { parseInvokeResumeInput, type InvokeResult } from "#cli/invoke/result.js";
import { ClientError } from "#client/client-error.js";

const completed: InvokeResult = {
  status: "completed",
  sessionEnded: false,
  reply: "Finished.",
  interactions: [],
  resume: {
    deliveryId: "delivery-original",
    session: { sessionId: "session-1", streamIndex: 7 },
    target: { kind: "remote", serverUrl: "https://example.com/" },
  },
};

it("allows a follow-up after request completion without treating its session as ended", () => {
  expect(resolveInvokeOperation({ previous: completed, prompt: "Next task" })).toEqual({
    kind: "send",
    payload: { message: "Next task" },
    resume: completed.resume,
  });
  expect(() =>
    resolveInvokeOperation({ previous: { ...completed, sessionEnded: true }, prompt: "Next task" }),
  ).toThrow("session has ended");
});

it("follows the original delivery when a working invocation is resumed", () => {
  const working: InvokeResult = { ...completed, status: "working", reply: undefined };
  expect(resolveInvokeOperation({ previous: working })).toEqual({
    kind: "follow",
    resume: completed.resume,
  });
  expect(() => resolveInvokeOperation({ previous: working, prompt: "Another task" })).toThrow(
    "working invocation",
  );
});

it("polls sign-ins but requires an answer for other awaiting-input interactions", () => {
  const waiting: InvokeResult = {
    ...completed,
    status: "awaiting-input",
    reply: undefined,
    interactions: [
      {
        interactionId: "sign-in-1",
        status: "open",
        turnId: "turn-1",
        stepIndex: 0,
        request: {
          kind: "sign-in",
          prompt: "Connect your calendar.",
          signIn: { name: "calendar", url: "https://example.com/connect" },
        },
      },
    ],
  };
  expect(resolveInvokeOperation({ previous: waiting })).toEqual({
    kind: "follow",
    resume: completed.resume,
    turnId: "turn-1",
  });
  const question: InvokeResult = {
    ...waiting,
    interactions: [
      {
        ...waiting.interactions[0]!,
        request: { kind: "question", prompt: "Which calendar?", allowFreeform: true },
      },
    ],
  };
  expect(() => resolveInvokeOperation({ previous: question })).toThrow("waiting for an answer");
  expect(resolveInvokeOperation({ previous: question, prompt: "Alice's calendar" })).toEqual({
    kind: "send",
    payload: { message: "Alice's calendar" },
    resume: completed.resume,
  });
});

it("follows successive sign-ins in the original turn without reading the next turn", async () => {
  resolveClient.mockResolvedValue({ options: {} });
  const events: SessionEvent[] = [
    { type: "delivery.admitted", data: { deliveryId: "delivery-original" } },
    {
      type: "turn.started",
      data: { turnId: "turn-1", follows: null, cause: { deliveryId: "delivery-original" } },
    },
    {
      type: "delivery.consumed",
      data: { deliveryId: "delivery-original", turnId: "turn-1", parts: [] },
    },
    {
      type: "interaction.opened",
      scope: { turnId: "turn-1" },
      data: {
        interactionId: "sign-in-1",
        request: {
          kind: "sign-in",
          prompt: "Connect calendar",
          signIn: { name: "calendar", url: "https://example.com/connect" },
        },
        subject: { callId: "call-1" },
      },
    },
    { type: "turn.paused", data: { turnId: "turn-1", awaiting: [{ interactionId: "sign-in-1" }] } },
    {
      type: "delivery.settled",
      data: { deliveryId: "delivery-original", turnId: "turn-1", outcome: "awaiting-input" },
    },
    {
      type: "interaction.settled",
      scope: { turnId: "turn-1" },
      data: { interactionId: "sign-in-1", outcome: "accepted" },
    },
    {
      type: "interaction.opened",
      scope: { turnId: "turn-1" },
      data: {
        interactionId: "sign-in-2",
        request: {
          kind: "sign-in",
          prompt: "Connect mail",
          signIn: { name: "mail", url: "https://example.com/connect-mail" },
        },
        subject: { callId: "call-2" },
      },
    },
    { type: "turn.paused", data: { turnId: "turn-1", awaiting: [{ interactionId: "sign-in-2" }] } },
    {
      type: "interaction.settled",
      scope: { turnId: "turn-1" },
      data: { interactionId: "sign-in-2", outcome: "accepted" },
    },
    {
      type: "content.completed",
      scope: { turnId: "turn-1", runId: "run-1" },
      data: {
        partId: "reply-1",
        runId: "run-1",
        kind: "text",
        phase: "reply",
        value: "Connected.",
      },
    },
    { type: "turn.settled", data: { turnId: "turn-1", outcome: "completed", reply: ["reply-1"] } },
    { type: "delivery.admitted", data: { deliveryId: "delivery-next" } },
    {
      type: "turn.started",
      data: { turnId: "turn-2", follows: "turn-1", cause: { deliveryId: "delivery-next" } },
    },
    {
      type: "content.completed",
      scope: { turnId: "turn-2", runId: "run-2" },
      data: {
        partId: "reply-2",
        runId: "run-2",
        kind: "text",
        phase: "reply",
        value: "Wrong turn.",
      },
    },
    { type: "turn.settled", data: { turnId: "turn-2", outcome: "completed", reply: ["reply-2"] } },
  ];
  const recorded = stampTestEvents(events).map((event, index) =>
    index === 4
      ? { ...event, meta: { ...event.meta, position: { line: 5, index: 0 }, endOfLine: false } }
      : index === 5
        ? { ...event, meta: { ...event.meta, position: { line: 5, index: 1 } } }
        : event,
  );
  attach.mockImplementation(() => ({
    state: { sessionId: "session-1", streamIndex: 0 },
    stream: () =>
      (async function* () {
        yield* recorded;
      })(),
  }));
  const previous: InvokeResult = {
    ...completed,
    status: "awaiting-input",
    reply: undefined,
    interactions: [
      {
        interactionId: "sign-in-1",
        turnId: "turn-1",
        stepIndex: 0,
        status: "open",
        request: {
          kind: "sign-in",
          prompt: "Connect calendar",
          signIn: { name: "calendar", url: "https://example.com/connect" },
        },
      },
    ],
  };
  const target = {
    kind: "remote" as const,
    serverUrl: "https://example.com/",
    workspaceRoot: "/tmp",
  };
  const operation = resolveInvokeOperation({ previous: parseInvokeResumeInput(previous) });
  const waiting = await runInvoke({ target, operation });
  expect(waiting.status).toBe("awaiting-input");
  expect(waiting.interactions.map((interaction) => interaction.interactionId)).toEqual([
    "sign-in-2",
  ]);
  expect(waiting.resume.deliveryId).toBe("delivery-original");
  expect(waiting.resume.turnId).toBe("turn-1");
  expect(waiting.resume.pauseLine).toEqual(expect.any(Number));
  const initialController = new AbortController();
  attach.mockImplementation(() => ({
    state: { sessionId: "session-1", streamIndex: 6 },
    stream: () =>
      (async function* () {
        yield* recorded.slice(0, 6);
        initialController.abort();
        throw new Error("stream interrupted");
      })(),
  }));
  const initialInterruption = await runInvoke({
    target,
    operation,
    signal: initialController.signal,
  });
  expect(initialInterruption.status).toBe("working");
  expect(parseInvokeResumeInput(initialInterruption).resume.turnId).toBe("turn-1");
  attach.mockImplementation(() => ({
    state: { sessionId: "session-1", streamIndex: 0 },
    stream: () =>
      (async function* () {
        yield* recorded;
      })(),
  }));
  const afterInitialInterruption = await runInvoke({
    target,
    operation: resolveInvokeOperation({ previous: parseInvokeResumeInput(initialInterruption) }),
  });
  expect(
    afterInitialInterruption.interactions.map((interaction) => interaction.interactionId),
  ).toEqual(["sign-in-2"]);
  const continueOperation = resolveInvokeOperation({ previous: parseInvokeResumeInput(waiting) });
  const result = await runInvoke({ target, operation: continueOperation });
  expect(result.status).toBe("completed");
  expect(result.reply).toBe("Connected.");
  expect(result.interactions).toEqual([]);
  expect(result.resume.deliveryId).toBe("delivery-original");
  const controller = new AbortController();
  attach.mockImplementation(() => ({
    state: { sessionId: "session-1", streamIndex: 9 },
    stream: () =>
      (async function* () {
        yield* recorded.slice(0, 9);
        controller.abort();
        throw new Error("stream interrupted");
      })(),
  }));
  const interrupted = await runInvoke({
    target,
    operation: continueOperation,
    signal: controller.signal,
  });
  expect(interrupted.status).toBe("working");
  expect(parseInvokeResumeInput(interrupted).resume).toMatchObject({
    deliveryId: "delivery-original",
    turnId: "turn-1",
    pauseLine: waiting.resume.pauseLine,
  });
  expect(resolveInvokeOperation({ previous: parseInvokeResumeInput(interrupted) })).toEqual({
    kind: "follow",
    resume: interrupted.resume,
    turnId: "turn-1",
  });
  attach.mockImplementation(() => ({
    state: { sessionId: "session-1", streamIndex: 0 },
    stream: () =>
      (async function* () {
        yield* recorded;
      })(),
  }));
  const resumed = await runInvoke({
    target,
    operation: resolveInvokeOperation({ previous: parseInvokeResumeInput(interrupted) }),
  });
  expect(resumed.status).toBe("completed");
  expect(resumed.reply).toBe("Connected.");
  const ordinaryWorking = { ...completed, status: "working" as const, reply: undefined };
  const receipt = await runInvoke({
    target,
    operation: resolveInvokeOperation({ previous: parseInvokeResumeInput(ordinaryWorking) }),
  });
  expect(receipt.status).toBe("awaiting-input");
  expect(receipt.interactions.map((interaction) => interaction.interactionId)).toEqual([
    "sign-in-1",
  ]);
  expect(receipt.resume.turnId).toBeUndefined();
  expect(receipt.resume.pauseLine).toBeUndefined();
  attach.mockImplementation(() => ({
    state: { sessionId: "session-1", streamIndex: 0 },
    send: async () =>
      Object.assign(
        (async function* () {
          yield* stampTestEvents([
            ...events.slice(12),
            {
              type: "delivery.settled",
              data: { deliveryId: "delivery-next", turnId: "turn-2", outcome: "handled" },
            },
          ]);
        })(),
        { deliveryId: "delivery-next" },
      ),
  }));
  const next = await runInvoke({
    target,
    operation: resolveInvokeOperation({
      previous: parseInvokeResumeInput(result),
      prompt: "Next task",
    }),
  });
  expect(next.status).toBe("completed");
  expect(next.reply).toBe("Wrong turn.");
  expect(next.resume.deliveryId).toBe("delivery-next");
  expect(next.resume.turnId).toBeUndefined();
  expect(next.resume.pauseLine).toBeUndefined();
});

it("keeps an accepted delivery resumable when credentials fail while following it", async () => {
  resolveClient.mockResolvedValue({ options: {} });
  attach.mockImplementation(() => ({
    state: { sessionId: "session-1", streamIndex: 3 },
    stream: () =>
      (async function* (): AsyncGenerator<SessionEvent> {
        yield* [];
        throw new ClientError(401, JSON.stringify({ ok: false, code: "unauthorized" }));
      })(),
  }));
  const operation = resolveInvokeOperation({
    previous: parseInvokeResumeInput({ ...completed, status: "working", reply: undefined }),
  });

  const failure = await runInvoke({
    target: { kind: "remote", serverUrl: "https://example.com/", workspaceRoot: "/tmp" },
    operation,
  }).then(
    () => expect.unreachable(),
    (error: Error) => error,
  );

  expect(failure.message).toContain("rejected the available credentials");
  const resumable = parseInvokeResumeInput(JSON.parse(failure.message.split("\n").at(-1)!));
  expect(resumable).toMatchObject({
    status: "working",
    resume: { deliveryId: "delivery-original", session: { sessionId: "session-1" } },
  });
});

it("requires delivery identity and excludes credentials from resumable JSON", () => {
  expect(parseInvokeResumeInput(completed)).toEqual(completed);
  expect(() =>
    parseInvokeResumeInput({
      ...completed,
      resume: { ...completed.resume, deliveryId: undefined },
    }),
  ).toThrow("not a valid resumable");
  expect(() =>
    parseInvokeResumeInput({
      ...completed,
      resume: { ...completed.resume, headers: { Authorization: "not-a-credential" } },
    }),
  ).toThrow("not a valid resumable");
});
