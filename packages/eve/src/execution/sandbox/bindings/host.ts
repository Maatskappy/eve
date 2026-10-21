import type { Dirent } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  createSandboxBackendImplementation,
  type InternalSandboxBackendContext,
  type InternalSandboxBackendDefinition,
  type SandboxBackendArtifact,
  type SandboxBackendState,
} from "#execution/sandbox/backend.js";
import {
  openHostSandboxInstance,
  removeHostSessionDirectory,
} from "#execution/sandbox/bindings/host-session.js";
import { resolveLocalProviderTemplatesDirectory } from "#execution/sandbox/bindings/local-provider-utils.js";
import {
  LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS,
  LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT,
  selectStaleTemplateEntries,
} from "#execution/sandbox/bindings/local-template-prune.js";
import { HOST_PROVIDER_NAME } from "#execution/sandbox/host-provider-name.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import type { HostSandboxEnvironmentOptions } from "#public/sandbox/host-sandbox.js";
import type { SandboxProviderImplementation } from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export { HOST_PROVIDER_NAME };

const WORKSPACE_DIRECTORY_NAME = "workspace";

/**
 * Per-session mode: the session directory holds the workspace, skills, and
 * `bash` tool jobs. eve prepares it once per build as a directory template
 * and copies it in for each new session; a removed workspace is gone.
 */
const SESSION_HOST_BACKEND: InternalSandboxBackendDefinition<HostSandboxEnvironmentOptions> = {
  name: HOST_PROVIDER_NAME,
  directoryTemplate: true,
  keyedToolSessions: true,
  workspaceRoot: (context) => join(context.directory, WORKSPACE_DIRECTORY_NAME),
  async open(context) {
    await mkdir(join(context.directory, WORKSPACE_DIRECTORY_NAME), { recursive: true });
    return { instance: await openHostSandboxInstance(context) };
  },
  async find(context) {
    return (await isDirectory(join(context.directory, WORKSPACE_DIRECTORY_NAME)))
      ? await openHostSandboxInstance(context)
      : undefined;
  },
  remove: async (context) => await removeHostSessionDirectory(context.directory),
};

/**
 * Shared-root mode: commands run in the author's directory, which eve never
 * seeds, creates, or deletes. The session directory still holds skills and
 * jobs. Without a directory template, eve writes no workspace files.
 */
const SHARED_HOST_BACKEND: InternalSandboxBackendDefinition<HostSandboxEnvironmentOptions> = {
  name: HOST_PROVIDER_NAME,
  keyedToolSessions: true,
  workspaceRoot: sharedRoot,
  async open(context, options) {
    await requireSharedRoot(sharedRoot(context, options));
    await mkdir(context.directory, { recursive: true });
    return { instance: await openHostSandboxInstance(context) };
  },
  // A missing shared root is the author's to fix, never a gone sandbox.
  find: async (context, options) => (await SHARED_HOST_BACKEND.open(context, options)).instance,
  remove: async (context) => await removeHostSessionDirectory(context.directory),
};

/** Creates the host provider on eve's sandbox backend contract. */
export function createHostSandboxProvider(
  options: HostSandboxEnvironmentOptions = {},
): SandboxProviderImplementation<
  undefined,
  SandboxBackendArtifact,
  SandboxBackendState,
  SandboxSession
> {
  if (process.platform === "win32") return windowsHostProvider();
  return createSandboxBackendImplementation(
    options.root === undefined ? SESSION_HOST_BACKEND : SHARED_HOST_BACKEND,
    options,
  );
}

/**
 * HostSandbox needs a POSIX shell. On Windows, preparing succeeds so builds of
 * environments that never open still work, and opening fails with the fix.
 */
function windowsHostProvider(): ReturnType<typeof createHostSandboxProvider> {
  const fail = async (): Promise<never> => {
    throw new Error(
      "HostSandbox requires a POSIX shell and does not run on Windows; use WSL or DockerSandbox.",
    );
  };
  return {
    prepare: async () => ({ templateKey: "windows" }),
    start: fail,
    resume: fail,
    onSessionEnd: async () => {},
  };
}

/** Removes stale host template directories for one application. */
export async function pruneHostSandboxTemplates(input: {
  readonly appRoot: string;
  readonly now?: number;
  readonly recentWindowMs?: number;
  readonly retainCount?: number;
}): Promise<void> {
  const templatesDirectory = resolveLocalProviderTemplatesDirectory(
    resolveSandboxCacheDirectory(input.appRoot),
    HOST_PROVIDER_NAME,
  );
  const now = input.now ?? Date.now();
  const recentWindowMs = input.recentWindowMs ?? LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS;
  const retainCount = input.retainCount ?? LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT;
  let entries: Dirent<string>[];
  try {
    entries = await readdir(templatesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(templatesDirectory, entry.name);
        return {
          isTemporary: entry.name.endsWith(".tmp"),
          mtimeMs: (await stat(path)).mtimeMs,
          path,
        };
      }),
  );
  const stale = [
    ...selectStaleTemplateEntries(
      directories.filter((directory) => !directory.isTemporary),
      { now, recentWindowMs, retainCount },
    ),
    ...selectStaleTemplateEntries(
      directories.filter((directory) => directory.isTemporary),
      { now, recentWindowMs, retainCount: 0 },
    ),
  ];
  await Promise.all(stale.map((entry) => rm(entry.path, { force: true, recursive: true })));
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true;
}

function sharedRoot(
  context: InternalSandboxBackendContext,
  options: HostSandboxEnvironmentOptions,
): string {
  return context.resolveProjectPath(options.root ?? ".");
}

async function requireSharedRoot(root: string): Promise<void> {
  if (!(await isDirectory(root))) {
    throw new Error(
      `HostSandbox root "${root}" does not exist. Create it, or change \`root\` in ` +
        "agent/sandbox/sandbox.ts; eve never creates a shared root.",
    );
  }
}
