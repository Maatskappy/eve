import {
  defineSandbox,
  type RuntimeSandboxSession,
  type SandboxSelectorContext,
} from "#public/definitions/sandbox.js";
import { HostSandbox } from "#sandbox/providers/host.js";
import { createDefaultVercelEnvironment } from "#sandbox/providers/vercel.js";
import { bindSandboxEnvironment } from "#shared/sandbox-environment.js";

import { resolveSelfModificationConfig, type SelfModificationConfig } from "./config.js";
import { isLocalSelfModificationEnabled } from "./mode.js";

export interface SelfModificationSandboxOptions {
  readonly config?: SelfModificationConfig;
}

export interface SelfModificationSandbox {
  (context: SandboxSelectorContext): Promise<RuntimeSandboxSession> | RuntimeSandboxSession;
}

const LOCAL_ONLY_MESSAGE =
  "Local self-modification runs only during `eve dev`, where its sandbox is the application directory.";

/**
 * Defines the local self-modification sandbox: the application directory itself,
 * through the host sandbox, during development. Other builds bind the default
 * Vercel environment, whose empty preparation is a no-op, so they compile and
 * prewarm on any host; the local child is never offered there, so opening fails.
 */
export function defineSelfModificationSandbox(
  options: SelfModificationSandboxOptions = {},
): SelfModificationSandbox {
  if (isLocalSelfModificationEnabled(resolveSelfModificationConfig(options.config))) {
    const environment = HostSandbox.environment({ root: "." });
    return bindSandboxEnvironment(
      defineSandbox(() => environment.open()),
      environment,
    );
  }
  const environment = createDefaultVercelEnvironment();
  return bindSandboxEnvironment(
    defineSandbox(async () => {
      throw new Error(LOCAL_ONLY_MESSAGE);
    }),
    environment,
  );
}

export default defineSelfModificationSandbox();
