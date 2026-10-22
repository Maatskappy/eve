import type { ContextContainer } from "#context/container.js";
import {
  DynamicSkillManifestKey,
  SandboxSkillContributorsKey,
  SessionIdKey,
} from "#context/keys.js";
import type { EnsuredSandboxAccess } from "#execution/sandbox/ensure.js";
import type { SandboxState } from "#sandbox/state.js";
import { SandboxSessionGoneError } from "#shared/sandbox-session-gone-error.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { requestSandboxReadiness } from "./request-readiness.js";

/** Borrowers resume acknowledged state; only the physical owner installs packages. */
export function withOwnerSandboxReadiness(input: {
  readonly ctx: ContextContainer;
  readonly ownerSessionId: string;
  readonly access: EnsuredSandboxAccess;
  readonly resume: (state: SandboxState) => Promise<EnsuredSandboxAccess>;
}): EnsuredSandboxAccess {
  const { ctx } = input;
  let access = input.access;
  let prepared = false;
  let preparedManifest = ctx.get(DynamicSkillManifestKey);
  let preparedContributors = ctx.get(SandboxSkillContributorsKey);
  let preparing: Promise<SandboxSession | null> | undefined;
  return {
    ...access,
    captureState: () => access.captureState(),
    detach: () => access.detach(),
    end: (reason) => access.end(reason),
    stop: () => access.stop(),
    delete: access.delete === undefined ? undefined : (options) => access.delete!(options),
    async get(abortSignal) {
      if (preparing !== undefined) return await preparing;
      const pending = (async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const manifest = ctx.get(DynamicSkillManifestKey);
          const contributors = ctx.get(SandboxSkillContributorsKey);
          try {
            if (
              !prepared ||
              manifest !== preparedManifest ||
              contributors !== preparedContributors
            ) {
              const requesterSessionId = ctx.require(SessionIdKey);
              const state = await requestSandboxReadiness({
                ownerSessionId: input.ownerSessionId,
                requesterSessionId,
                abortSignal,
                contributors:
                  requesterSessionId === input.ownerSessionId
                    ? undefined
                    : {
                        ...contributors,
                        [requesterSessionId]: manifest ?? {},
                      },
              });
              await access.detach();
              access = await input.resume(state);
            }
            const sandbox = await access.get(abortSignal);
            prepared = true;
            preparedManifest = manifest;
            preparedContributors = contributors;
            return sandbox;
          } catch (error) {
            prepared = false;
            if (!(error instanceof SandboxSessionGoneError) || attempt === 1) throw error;
          }
        }
        throw new Error("The session sandbox could not be resumed.");
      })();
      preparing = pending;
      try {
        return await pending;
      } finally {
        preparing = undefined;
      }
    },
  };
}
