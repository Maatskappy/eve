import { buildCallbackContext } from "#context/build-callback-context.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { bindSandboxAbortSignal } from "#execution/sandbox/abort-bound-session.js";
import { hydrateDurableSession } from "#execution/session.js";
import { createLogger, logError } from "#internal/logging.js";
import type { PrewarmContext } from "#public/definitions/hook.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.prewarm");

/** Optional authored preparation; never emits events or initializes a turn. */
export async function prewarmSessionStep(input: {
  readonly abortSignal: AbortSignal;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
    durable: readDurableSession(input.sessionState),
    turnAgent: effectiveAgent.turnAgent,
  });
  const prepared = await withContextScope(ctx, session, async (enriched) => {
    const callback = buildCallbackContext();
    for (const hook of bundle.hookRegistry.prewarm ?? []) {
      if (input.abortSignal.aborted) break;
      const controller = new AbortController();
      const abortSignal = AbortSignal.any([input.abortSignal, controller.signal]);
      const pending = new Set<Promise<void>>();
      let active = true;
      const prewarm: PrewarmContext = {
        abortSignal,
        agent: { name: bundle.turnAgent.id, nodeId: bundle.nodeId },
        session: { id: callback.session.id, auth: callback.session.auth },
        preload(asset, prepare) {
          if (!active) throw new Error("ctx.preload() called after the prewarm hook returned.");
          if (asset !== "sandbox") throw new TypeError('ctx.preload() supports only "sandbox".');
          const work = (async () => {
            abortSignal.throwIfAborted();
            const sandbox = await callback.getSandbox();
            abortSignal.throwIfAborted();
            await prepare?.(bindSandboxAbortSignal(sandbox, abortSignal));
          })();
          pending.add(work);
          void work.then(
            () => pending.delete(work),
            () => pending.delete(work),
          );
          return work;
        },
      };
      try {
        await hook.handler(prewarm);
      } catch (error) {
        logError(log, "prewarm hook failed", error, {
          hook: hook.slug,
          sessionId: session.sessionId,
        });
      } finally {
        active = false;
        controller.abort();
        await Promise.allSettled(pending);
      }
    }
    return { result: undefined, session: enriched };
  });
  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session: prepared.session }),
  };
}
