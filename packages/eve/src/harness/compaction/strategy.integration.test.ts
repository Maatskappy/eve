import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import type { CompactionStrategy } from "#harness/compaction/strategy.js";
import { eventsOf } from "#harness/publication.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession } from "#harness/types.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { readReactionsState, writeReactionsState } from "#reactions/state.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const textStream = (text: string, inputTokens: number): StreamResult => ({
  stream: new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of [
        { type: "stream-start", warnings: [] },
        { id: "t", type: "text-start" },
        { delta: text, id: "t", type: "text-delta" },
        { id: "t", type: "text-end" },
        {
          finishReason: { raw: undefined, unified: "stop" },
          type: "finish",
          usage: {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: inputTokens, total: inputTokens },
            outputTokens: { reasoning: 0, text: 4, total: 4 },
          },
        },
      ] as StreamPart[])
        controller.enqueue(part);
      controller.close();
    },
  }),
});

const isSummaryCall = (prompt: readonly { role: string; content: unknown }[]): boolean =>
  !String(prompt[0]?.content).includes("You help Alice.");

function session(history: HarnessSession["history"], threshold: number): HarnessSession {
  return {
    agent: { modelReference: { id: "turn-model" }, system: "You help Alice.", tools: [] },
    compaction: { recentWindowSize: 1, threshold },
    continuationToken: "http:strategy",
    history,
    sessionId: "strategy",
  };
}

async function run(input: {
  readonly ctx?: ContextContainer;
  readonly message: string;
  readonly model: MockLanguageModelV3;
  readonly session: HarnessSession;
  readonly strategy?: CompactionStrategy;
}): Promise<readonly SessionEvent[]> {
  const events: SessionEvent[] = [];
  const handle = foldingHandler();
  await contextStorage.run(input.ctx ?? new ContextContainer(), async () => {
    let stepped = await createToolLoopHarness({
      compactionStrategy: input.strategy,
      handleEvent: async (publication) => {
        events.push(...eventsOf(publication));
        await handle(publication);
      },
      resolveModel: async () => input.model,
      tools: new Map(),
    })(input.session, { message: input.message });
    while (typeof stepped.next === "function") stepped = await stepped.next(stepped.session);
  });
  return events;
}

const contextStarts = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.type === "context.started");

describe("compaction triggers", () => {
  it("compacts once for a request that alone exceeds the limit, then runs on", async () => {
    let summaries = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        if (isSummaryCall(prompt)) {
          summaries++;
          return textStream("Alice sent a very long document.", 120);
        }
        // The provider counts about 1.6x what the estimate does, close under the limit.
        return textStream("Done.", 19_000);
      },
    });

    const events = await run({
      message: "Summarize this. " + "word ".repeat(80_000),
      model,
      session: session([], 20_000),
    });

    expect(contextStarts(events)).toHaveLength(1);
    expect(summaries).toBe(1);
    expect(events.map(({ type }) => type)).toContain("turn.settled");
    expect(events.some((event) => event.type === "session.ended")).toBe(false);
  });

  it("runs the default strategy once when a strategy's result is still over the limit", async () => {
    let summaries = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        if (isSummaryCall(prompt)) {
          summaries++;
          return textStream("Earlier notes, summarized.", 120);
        }
        return textStream("Done.", 500);
      },
    });
    const compact = vi.fn<CompactionStrategy["compact"]>(async (history) => history);

    const events = await run({
      message: "Please continue.",
      model,
      session: session(
        [{ content: "Earlier notes. ".repeat(2_000), kind: "user", role: "user" }],
        2_000,
      ),
      strategy: { compact },
    });

    expect(compact).toHaveBeenCalledOnce();
    expect(summaries).toBe(1);
    expect(contextStarts(events)).toHaveLength(1);
    expect(events.filter((event) => event.type === "context.settled")).toMatchObject([
      { data: { outcome: "completed" } },
    ]);
  });

  it("compacts before the next model call when a hook asked, and only once", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => textStream("Done.", 500),
    });
    const compact = vi.fn<CompactionStrategy["compact"]>(async (history) => history.slice(-1));
    const ctx = new ContextContainer();
    writeReactionsState(ctx, {
      ...readReactionsState(ctx),
      intents: [{ occurrence: "o", reactionId: "hooks/trim.ts", type: "compact" }],
    });

    const history = [
      { content: "First question.", kind: "user" as const, role: "user" as const },
      { content: "First answer.", role: "assistant" as const },
    ];
    const events = await run({
      ctx,
      message: "Second question.",
      model,
      session: session(history, 100_000),
      strategy: { compact },
    });

    expect(compact).toHaveBeenCalledOnce();
    expect(compact.mock.calls[0]?.[1]).toMatchObject({ forced: true });
    expect(contextStarts(events)).toHaveLength(1);
    expect(readReactionsState(ctx).intents ?? []).toEqual([]);
  });
});
