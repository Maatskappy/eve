import type { SandboxSession } from "#shared/sandbox-session.js";

import { isDeployedRuntime } from "./mode.js";

/** Where a deployed child's sandbox links the checkout's `agent/` directory. */
export const DEPLOYED_SOURCE_ROOT = "/source";

/**
 * Local development paths, relative to the app root. The local child's host
 * sandbox uses the app root as its workspace root, so these resolve in place.
 */
export const LOCAL_SOURCE_PATH = "agent";
export const LOCAL_TRACES_PATH = ".eve/traces/v1";
export const LOCAL_LOGS_PATH = ".eve/logs";
export const LOCAL_DOCS_PATH = "node_modules/eve/docs";

/** The authored `agent/` directory as the active self-modification child's sandbox sees it. */
export function selfModificationSourceRoot(sandbox: SandboxSession): string {
  return isDeployedRuntime() ? DEPLOYED_SOURCE_ROOT : sandbox.resolvePath(LOCAL_SOURCE_PATH);
}
