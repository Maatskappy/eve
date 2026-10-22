import { randomUUID } from "node:crypto";
import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import type { DynamicSkillManifest } from "#context/keys.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { getRun } from "#internal/workflow/runtime.js";
import type { SandboxState } from "#sandbox/state.js";
import type { SandboxReadinessReply } from "./readiness-types.js";

/** Borrows readiness from the session owner without restarting the requesting step. */
export async function requestSandboxReadiness(input: {
  readonly ownerSessionId: string;
  readonly requesterSessionId: string;
  readonly abortSignal?: AbortSignal;
  readonly contributors?: Readonly<Record<string, DynamicSkillManifest>>;
}): Promise<SandboxState> {
  const runId = getWorkflowMetadata().workflowRunId;
  const namespace = `eve.sandbox-ready:${randomUUID()}`;
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(input.abortSignal === undefined ? [] : [input.abortSignal]),
  ]);
  signal.throwIfAborted();
  await resumeSessionInbox(
    { sessionId: input.ownerSessionId },
    {
      kind: "sandbox-readiness",
      requesterSessionId: input.requesterSessionId,
      runId,
      namespace,
      contributors: input.contributors,
    },
  );
  const reader = getRun(runId).getReadable<SandboxReadinessReply>({ namespace }).getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    signal.throwIfAborted();
    if (done || value?.ok !== true)
      throw new Error("The session owner could not prepare its sandbox. Retry sandbox access.");
    return value.state;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
