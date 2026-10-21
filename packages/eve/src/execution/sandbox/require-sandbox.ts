import { posix } from "node:path";

import type { SandboxSession } from "#public/definitions/sandbox.js";
import { sandboxWorkspaceRoot } from "#shared/sandbox-session.js";
import { resolveSandboxModelPath } from "#shared/skill-paths.js";

/**
 * Resolves a model-supplied file path to an absolute sandbox path: a leading
 * `$HOME` through the sandbox's home or skill root, and a relative path from
 * the workspace root, the same way `bash` commands see it.
 */
export async function resolveAbsoluteFilePath(
  sandbox: SandboxSession,
  filePath: string,
): Promise<string> {
  const homeResolved = await resolveSandboxModelPath({ path: filePath, sandbox });
  const resolvedPath = homeResolved.startsWith("/")
    ? homeResolved
    : posix.join(sandboxWorkspaceRoot(sandbox), homeResolved);

  if (!resolvedPath.startsWith("/")) {
    throw new Error(
      `Could not resolve "${filePath}" to an absolute path in the sandbox. ` +
        "Use an absolute path or a path beginning with $HOME/.",
    );
  }

  return resolvedPath;
}
