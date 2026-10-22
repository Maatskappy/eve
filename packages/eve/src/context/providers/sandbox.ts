import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import type { HarnessSessionBase } from "#harness/types.js";
import type { SandboxAccess, SandboxState } from "#sandbox/state.js";
import type { ContextContainer } from "#context/container.js";
import {
  ParentSessionKey,
  SandboxKey,
  SandboxTerminalCleanupKey,
  SessionIdKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getActiveRuntimeNode } from "#context/node.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { withDynamicSkillFiles } from "#context/dynamic-skill-files.js";
import { withOwnerSandboxReadiness } from "#execution/sandbox/borrow-readiness.js";

export const sandboxProvider: FrameworkContextProvider<SandboxAccess> = {
  key: SandboxKey,

  async create(ctx: ContextContainer, session: HarnessSessionBase) {
    const bundle = ctx.get(BundleKey);
    if (bundle === undefined) return undefined;
    const node = getActiveRuntimeNode(ctx);
    const registry = node.sandboxRegistry;
    const sessionId = ctx.require(SessionIdKey);
    const channel = ctx.get(ChannelKey);
    const adapterState = channel?.state as Record<string, unknown> | undefined;
    const parentSandboxState = adapterState?.parentSandboxState as SandboxState | undefined;
    const inheritsParent = registry.sandbox?.definition.kind === "parent";
    const ownerSandboxSessionId = adapterState?.sandboxSessionId as string | undefined;
    const reusesOwnerSandbox = inheritsParent || ownerSandboxSessionId !== undefined;
    const sandboxSessionId = reusesOwnerSandbox ? (ownerSandboxSessionId ?? sessionId) : sessionId;

    const options = {
      compiledArtifactsSource: bundle.compiledArtifactsSource,
      nodeId: node.nodeId,
      ownsSandbox: !reusesOwnerSandbox,
      borrowed: reusesOwnerSandbox,
      registry,
      sessionId: sandboxSessionId,
      state: session.sandboxState ?? (reusesOwnerSandbox ? parentSandboxState : undefined) ?? null,
    };
    const access = await ensureSandboxAccess(options);
    ctx.setVirtualContext(SandboxTerminalCleanupKey, (reason) => access.end(reason));
    return {
      value: reusesOwnerSandbox
        ? withOwnerSandboxReadiness({
            ctx,
            ownerSessionId: ctx.get(ParentSessionKey)?.sessionId ?? sandboxSessionId,
            access,
            resume: (state) => ensureSandboxAccess({ ...options, state, resumeOnly: true }),
          })
        : withDynamicSkillFiles(ctx, access),
    };
  },

  async commit(access, session) {
    const state = await access.captureState();
    return { ...session, sandboxState: state };
  },
};
