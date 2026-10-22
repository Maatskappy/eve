import {
  pruneEndedSandboxSkillContributors,
  updateSandboxSkillContributors,
} from "#context/dynamic-skill-files.js";
import { SandboxKey, SessionIdKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import {
  EVE_SANDBOX_OWNER_ATTRIBUTE,
  EVE_SESSION_ATTRIBUTE,
  readSharedSandboxOwnerSessionId,
} from "#execution/eve-workflow-attributes.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import { hydrateDurableSession } from "#execution/session.js";
import { withSessionStateDelta } from "#execution/session/state-delta.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { readTaskTable } from "#execution/tasks/table.js";
import { createLogger, logError } from "#internal/logging.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { SandboxReadinessReply, SandboxReadinessRequest } from "./readiness-types.js";

const log = createLogger("sandbox.readiness");

/** Only the owner mutates its package installation records and filesystem. */
export async function prepareRequestedSandboxStep(
  input: SessionStepState & {
    readonly request: SandboxReadinessRequest;
    readonly prepare: boolean;
    readonly abortSignal?: AbortSignal;
  },
) {
  "use step";
  return await withSessionStateDelta(input, async (state) => {
    const ctx = await deserializeContext(state.serializedContext);
    const durable = readDurableSession(state.sessionState);
    const ownerId = ctx.require(SessionIdKey);
    const { request } = input;
    const noReply = {
      serializedContext: state.serializedContext,
      sessionState: state.sessionState,
      reply: undefined as SandboxReadinessReply | undefined,
    };
    if (!/^eve\.sandbox-ready:[a-f0-9-]{36}$/u.test(request.namespace)) return noReply;
    const ownRun = request.requesterSessionId === ownerId;
    if (ownRun) {
      const registered =
        getBlockingWorkflowToolRuns(durable.state).some(
          (run) => run.address.runId === request.runId,
        ) || readTaskTable(durable.state).tasks.some((task) => task.run?.runId === request.runId);
      if (!registered) return noReply;
    } else {
      try {
        const run = await (await getWorld()).runs.get(request.runId, { resolveData: "none" });
        if (
          run.attributes?.["$eve.parent"] !== ownerId ||
          (run.attributes?.[EVE_SESSION_ATTRIBUTE] ?? request.runId) !==
            request.requesterSessionId ||
          run.attributes?.[EVE_SANDBOX_OWNER_ATTRIBUTE] !==
            (readSharedSandboxOwnerSessionId(state.serializedContext) ?? ownerId)
        )
          return noReply;
      } catch (error) {
        logError(log, "sandbox requester could not be validated", error, { sessionId: ownerId });
        return noReply;
      }
    }
    if (!input.prepare) return { ...noReply, reply: { ok: false } as SandboxReadinessReply };
    const bundle = ctx.require(BundleKey);
    const effective = resolveEffectiveAgentRuntime(bundle, ctx);
    const session = hydrateDurableSession({
      durable,
      turnAgent: effective.turnAgent,
      compactionOverrides: { thresholdPercent: effective.thresholdPercent },
    });
    let reply: SandboxReadinessReply = { ok: false };
    try {
      if (!ownRun && request.contributors !== undefined) {
        if (Object.hasOwn(request.contributors, ownerId))
          throw new Error("A borrower cannot replace the owner's skill contribution.");
        await pruneEndedSandboxSkillContributors(ctx);
        updateSandboxSkillContributors(ctx, request.contributors);
      }
      const prepared = await withContextScope(ctx, session, async (enriched) => {
        const access = ctx.require(SandboxKey);
        try {
          if ((await access.get(input.abortSignal)) !== null)
            reply = { ok: true, state: await access.captureState() };
        } catch (error) {
          logError(log, "sandbox preparation failed", error, { sessionId: ownerId });
        }
        return { result: undefined, session: enriched };
      });
      return {
        serializedContext: serializeContext(ctx),
        sessionState: createDurableSessionState({ session: prepared.session }),
        reply,
      };
    } catch (error) {
      logError(log, "sandbox readiness failed", error, { sessionId: ownerId });
      return { ...noReply, reply: { ok: false } as SandboxReadinessReply };
    }
  });
}

/** Runs only after the owner's state cursor adopted the readiness result. */
export async function replySandboxReadinessStep(input: {
  readonly request: SandboxReadinessRequest;
  readonly reply: SandboxReadinessReply;
}): Promise<void> {
  "use step";
  const writer = getRun(input.request.runId)
    .getWritable<SandboxReadinessReply>({ namespace: input.request.namespace })
    .getWriter();
  try {
    await writer.write(input.reply);
    await writer.close();
  } catch (error) {
    logError(log, "sandbox readiness reply failed", error);
  } finally {
    writer.releaseLock();
  }
}
