import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Experimental_DecisionMockModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey, SessionTraceSeedKey } from "#context/keys.js";
import { ensureOtelIntegration } from "#instrumentation/ai-sdk-telemetry.js";
import { createInstrumentationHooks } from "#instrumentation/lifecycle.js";
import {
  bindInstrumentationRuntime,
  registerInstrumentationRuntime,
} from "#instrumentation/runtime.js";
import { decide } from "#public/ai/index.js";
import { ConversationContextKey } from "#shared/conversation-context.js";
import type { TraceCapturePolicy } from "#shared/trace-policy.js";
import { createAgentOtelInstrumentation } from "#tracing/eve/agent-otel-provider.js";
import { ContextAgentTraceStateStore } from "#tracing/eve/agent-trace-context-store.js";
import { AgentSpanIdGenerator, otelTelemetry } from "#compiled/@vercel/agent-runs/index.js";
import { withCapture } from "#compiled/@vercel/agent-runs/otel.js";

const questions = {
  team: {
    type: "choice",
    instructions: "Select the team that can help Alice.",
    criteria: { billing: "Invoices and payments", support: "Product questions" },
  },
} as const;
const state = { request: "Alice needs a copy of her invoice." };
const answer = {
  answers: { team: { type: "choice" as const, choice: "billing" } },
  usage: { inputTokens: 42, outputTokens: 3 },
  warnings: [],
};

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let idGenerator: AgentSpanIdGenerator;
let runtime: ReturnType<typeof useRuntime>;

function useRuntime(tracePolicy?: TraceCapturePolicy) {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("eve.instrumentation-runtime")];
  const agent = createAgentOtelInstrumentation({
    environment: "production",
    frameworkVersion: "test",
    idGenerator,
    recordInputs: true,
    recordOutputs: true,
    stateStore: new ContextAgentTraceStateStore(),
    telemetry: otelTelemetry({ provider, idGenerator }),
    tracePolicy,
  });
  return registerInstrumentationRuntime({
    ...agent,
    hooks: createInstrumentationHooks([agent.hook]),
    ownsAgentSpans: true,
    otelSettings: {
      recordInputs: true,
      recordOutputs: true,
      traceChannelRequests: false,
      tracePolicy,
    },
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  });
}

async function inSession<T>(execute: (ctx: ContextContainer) => Promise<T>): Promise<T> {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "alice-session");
  ctx.set(ConversationContextKey, {
    audience: "private",
    channel: { kind: "http" },
    environment: "production",
    principalType: "user",
  });
  return contextStorage.run(ctx, async () => {
    const binding = bindInstrumentationRuntime(runtime, ctx, {
      agentName: "support",
      rootSessionId: "alice-session",
      sessionId: "alice-session",
    })!;
    await binding.preparePreamble({ sequence: 0, sessionStarted: false, turnId: "turn-1" });
    return execute(ctx);
  });
}

function decisions() {
  return exporter
    .getFinishedSpans()
    .filter((span) => span.attributes["gen_ai.operation.name"] === "decide");
}

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  idGenerator = new AgentSpanIdGenerator();
  provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  vi.stubGlobal("AI_SDK_TELEMETRY_INTEGRATIONS", []);
  runtime = useRuntime();
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("eve.instrumentation-runtime")];
  vi.unstubAllGlobals();
});

describe("decide tracing", () => {
  it("emits one decision span under the active tool and parents provider work to it", async () => {
    ensureOtelIntegration();
    const onStart = vi.fn();
    const model = new Experimental_DecisionMockModelV4({
      doDecide: async () => {
        trace.getTracer("test.provider").startSpan("decision request").end();
        return answer;
      },
    });
    let parentId: string | undefined;
    await inSession(async () => {
      await trace.getTracer("test.tool").startActiveSpan("classify request", async (span) => {
        parentId = span.spanContext().spanId;
        try {
          const result = await decide({ model, questions, state, onStart });
          expect(result.answers.team.choice).toBe("billing");
        } finally {
          span.end();
        }
      });
    });

    expect(decisions()).toHaveLength(1);
    const decision = decisions()[0]!;
    expect(decision.name).toBe(`decide ${model.modelId}`);
    expect(decision.parentSpanContext?.spanId).toBe(parentId);
    expect(decision.attributes).toMatchObject({
      "gen_ai.provider.name": model.provider,
      "gen_ai.request.model": model.modelId,
      "gen_ai.usage.input_tokens": 42,
      "gen_ai.usage.output_tokens": 3,
    });
    const request = exporter.getFinishedSpans().find((span) => span.name === "decision request")!;
    expect(request.parentSpanContext?.spanId).toBe(decision.spanContext().spanId);
    expect(onStart).toHaveBeenCalledOnce();
    expect(JSON.stringify(decision.attributes)).not.toContain(state.request);
    expect(JSON.stringify(decision.attributes)).not.toContain(questions.team.instructions);
  });

  it("parents routing decisions to the prepared turn before a model attempt exists", async () => {
    const model = new Experimental_DecisionMockModelV4({ doDecide: async () => answer });
    let parentId: string | undefined;
    await inSession(async (ctx) => {
      parentId = ctx.require(SessionTraceSeedKey).spanId;
      await decide({ model, questions, state });
    });
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]!.parentSpanContext?.spanId).toBe(parentId);
  });

  it("traces standalone calls using the resolved model rather than its alias", async () => {
    const model = new Experimental_DecisionMockModelV4({ doDecide: async () => answer });
    vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", { decisionModel: () => model });
    await decide({ model: "internal-decider", questions, state });
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]!.name).toBe(`decide ${model.modelId}`);
    expect(decisions()[0]!.attributes["gen_ai.request.model"]).toBe(model.modelId);
  });

  it.each(["provider", "validation", "abort"] as const)(
    "ends failed spans without leaking private %s errors",
    async (failure) => {
      const error = new Error("private invoice details");
      const model = new Experimental_DecisionMockModelV4({
        doDecide: async () => {
          if (failure === "provider") throw error;
          return failure === "validation" ? { answers: {}, warnings: [] } : answer;
        },
      });
      await inSession(async () => {
        await expect(
          decide({
            model,
            questions,
            state,
            maxRetries: 0,
            abortSignal: failure === "abort" ? AbortSignal.abort(error) : undefined,
          }),
        ).rejects.toThrow();
      });
      expect(decisions()).toHaveLength(1);
      expect(decisions()[0]!.status.code).toBe(SpanStatusCode.ERROR);
      expect(JSON.stringify(decisions()[0]!.events)).not.toContain(error.message);
      expect(JSON.stringify(decisions()[0]!.status)).not.toContain(error.message);
    },
  );

  it.each(["policy", "sampling", "call", "undeclared", "inherited", "suppressed"] as const)(
    "does not emit a decision span when disabled by %s",
    async (disabled) => {
      if (disabled === "policy") runtime = useRuntime(() => false);
      if (disabled === "undeclared") runtime.otelSettings = undefined;
      const model = new Experimental_DecisionMockModelV4({ doDecide: async () => answer });
      await inSession(async (ctx) => {
        if (disabled === "sampling") {
          const seed = ctx.require(SessionTraceSeedKey);
          ctx.set(SessionTraceSeedKey, { ...seed, traceFlags: 0 });
        }
        const run = () =>
          decide({
            model,
            questions,
            state,
            telemetry: disabled === "call" ? { isEnabled: false } : undefined,
          });
        const result =
          disabled === "suppressed"
            ? await otelTelemetry().suppressed!(run)
            : disabled === "inherited"
              ? await context.with(
                  withCapture(context.active(), {
                    emit: false,
                    recordInputs: false,
                    recordOutputs: false,
                  }),
                  run,
                )
              : await run();
        expect(result.answers.team.choice).toBe("billing");
      });
      expect(decisions()).toHaveLength(0);
    },
  );
});
