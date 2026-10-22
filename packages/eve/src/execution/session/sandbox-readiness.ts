import type { SandboxReadinessRequest } from "#execution/sandbox/readiness-types.js";
import {
  prepareRequestedSandboxStep,
  replySandboxReadinessStep,
} from "#execution/sandbox/readiness-step.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";

export async function handleSandboxReadiness(
  cursor: SessionStateCursor,
  request: SandboxReadinessRequest,
  prepare = true,
  abortSignal?: AbortSignal,
): Promise<void> {
  const { reply } = await cursor.advance((state) =>
    prepareRequestedSandboxStep({ ...state, request, prepare, abortSignal }),
  );
  if (reply !== undefined) await replySandboxReadinessStep({ request, reply });
}
