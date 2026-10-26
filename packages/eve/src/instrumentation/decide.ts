import {
  experimental_decide as decideWithAiSdk,
  type Experimental_DecisionQuestion as DecisionQuestion,
} from "ai";

import { context, createContextKey, trace, SpanKind } from "#compiled/@opentelemetry/api/index.js";
import { currentCapture, otelTelemetry } from "#compiled/@vercel/agent-runs/index.js";
import { withCapture } from "#compiled/@vercel/agent-runs/otel.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { getRegisteredTelemetryIntegrations } from "#instrumentation/ai-sdk-telemetry.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime-global.js";
import { readInstrumentationSessionContext } from "#instrumentation/session-context.js";
import { resolveInstrumentationTraceDecision } from "#instrumentation/trace-decision.js";
import { recordErrorOnSpan } from "#internal/logging.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { applyLiveDeliveryAudienceCeiling } from "#shared/forwarded-trace-policy.js";
import { readSessionTraceDecision } from "#tracing/eve/agent-trace-context-store.js";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import { withOperationTraceContext } from "#tracing/eve/conversation-context.js";
import { gatewayCostAttributes, readGatewayCostData } from "#tracing/eve/gateway.js";

const SUPPRESS_TRACING_KEY = createContextKey("OpenTelemetry SDK Context Key SUPPRESS_TRACING");

/** Decision calls can run before a model attempt or outside an eve session. */
export async function decideWithTracing<const Questions extends Record<string, DecisionQuestion>>(
  options: Parameters<typeof decideWithAiSdk<Questions>>[0],
) {
  const settings = getInstrumentationRuntime()?.otelSettings;
  if (settings === undefined || options.telemetry?.isEnabled === false) {
    return decideWithAiSdk(options);
  }
  const ctx = contextStorage.getStore() ?? new ContextContainer();
  const session = readInstrumentationSessionContext(ctx);
  const sessionId = ctx.get(SessionIdKey);
  const agentName = ctx.get(BundleKey)?.resolvedAgent.config?.name ?? "eve";
  const decision = resolveInstrumentationTraceDecision(
    settings,
    agentName,
    session.conversation,
    session.traceSeed,
    sessionId === undefined ? undefined : readSessionTraceDecision(ctx, sessionId),
  );
  const effective =
    decision === undefined
      ? undefined
      : applyLiveDeliveryAudienceCeiling(
          decision,
          session.audience,
          session.forwardedTracePolicy,
          session.conversation.environment,
        );
  const inherited = currentCapture();
  const capture = {
    emit: effective?.action === "record" && inherited?.emit !== false,
    recordInputs:
      settings.recordInputs &&
      effective?.action === "record" &&
      effective.recordInputs &&
      inherited?.recordInputs !== false &&
      options.telemetry?.recordInputs !== false,
    recordOutputs:
      settings.recordOutputs &&
      effective?.action === "record" &&
      effective.recordOutputs &&
      inherited?.recordOutputs !== false &&
      options.telemetry?.recordOutputs !== false,
  };
  // eve owns this operation; the SDK integration would emit a second pair of spans.
  const telemetry = {
    ...options.telemetry,
    integrations: options.telemetry?.integrations ?? [
      ...getRegisteredTelemetryIntegrations({ excludeEveOtelIntegration: true }),
    ],
    recordInputs: capture.recordInputs,
    recordOutputs: capture.recordOutputs,
  };
  let parent = context.active();
  if (trace.getSpan(parent) === undefined && session.traceSeed !== undefined) {
    parent = trace.setSpan(parent, trace.wrapSpanContext(session.traceSeed));
  }
  const reference = trace.getSpan(parent)?.spanContext();
  if (
    !capture.emit ||
    parent.getValue(SUPPRESS_TRACING_KEY) === true ||
    (session.traceSeed !== undefined && (session.traceSeed.traceFlags & 1) === 0) ||
    (reference !== undefined && (reference.traceFlags & 1) === 0)
  ) {
    return otelTelemetry().suppressed!(() => decideWithAiSdk({ ...options, telemetry }));
  }
  parent = withChannelAudience(parent, session.audience);
  if (sessionId !== undefined)
    parent = withOperationTraceContext(parent, {
      sessionId,
      rootSessionId: session.parent?.rootSessionId,
    });
  const modelId = typeof options.model === "string" ? options.model : options.model.modelId;
  const span = trace.getTracer("eve.ai").startSpan(
    `decide ${modelId}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "decide",
        "gen_ai.request.model": modelId,
        "gen_ai.agent.name": settings.functionId ?? agentName,
        "operation.name": "decide",
      },
    },
    parent,
  );
  return context.with(withCapture(trace.setSpan(parent, span), capture), async () => {
    try {
      const result = await decideWithAiSdk({
        ...options,
        telemetry,
        onStart: async (event) => {
          span.updateName(`decide ${event.modelId}`);
          span.setAttributes({
            "gen_ai.provider.name": event.provider,
            "gen_ai.request.model": event.modelId,
          });
          await options.onStart?.(event);
        },
      });
      span.setAttributes({
        "gen_ai.usage.input_tokens": result.usage.inputTokens,
        "gen_ai.usage.output_tokens": result.usage.outputTokens,
        "gen_ai.response.id": result.response.id,
        "gen_ai.response.model": result.response.modelId,
        ...gatewayCostAttributes(readGatewayCostData(result.providerMetadata) ?? {}),
      });
      return result;
    } catch (error) {
      recordErrorOnSpan(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}
