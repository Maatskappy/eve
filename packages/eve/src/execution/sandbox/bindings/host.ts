import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  openHostSandboxHandle,
  removeHostSessionDirectory,
} from "#execution/sandbox/bindings/host-session.js";
import {
  copyDirectoryAtomically,
  pathExists,
  resolveLocalProviderSessionRootPath,
  resolveLocalProviderTemplateRootPath,
  resolveLocalProviderTemplatesDirectory,
  touchDirectory,
} from "#execution/sandbox/bindings/local-provider-utils.js";
import {
  LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS,
  LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT,
  selectStaleTemplateEntries,
} from "#execution/sandbox/bindings/local-template-prune.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import { withToolSessionSandboxes } from "#execution/tool-session/sandbox.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import type { HostSandboxEnvironmentOptions } from "#public/sandbox/host-sandbox.js";
import {
  isSandboxPreparedArtifactRecord,
  sandboxProviderResourceIdentity,
  type SandboxPreparedArtifact,
  type SandboxProviderImplementation,
  type SandboxProviderResourceTree,
  type SandboxProviderSessionContext,
} from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";

export const HOST_PROVIDER_NAME = "host";

const WORKSPACE_DIRECTORY_NAME = "workspace";
const SKILLS_DIRECTORY_NAME = "skills";

// Holds the template key, not its path: the build and runtime app roots can differ.
type HostPreparedArtifact = { readonly templateKey: string };
type HostSessionState = { readonly root: string; readonly version: 1 };

/**
 * Creates the host provider. A template directory holds the skills, and in
 * per-session mode the seeded workspace; each session copies it once into a
 * directory derived from its session id, so keyed tool sessions and resume
 * find the same one. A shared `root` is used in place and never seeded or
 * deleted.
 */
export function createHostSandboxProvider(
  options: HostSandboxEnvironmentOptions = {},
): SandboxProviderImplementation<
  undefined,
  HostPreparedArtifact,
  HostSessionState,
  SandboxSession
> {
  const sharedRoot = options.root;

  const implementation: ReturnType<typeof createHostSandboxProvider> = {
    async prepare(context) {
      const templateKey = createSandboxProviderIdentity({
        resources: sandboxProviderResourceIdentity(context.resources),
        sharedRoot: sharedRoot !== undefined,
        sourceRevision: context.sourceRevision,
        version: 1,
      }).slice(0, 24);
      const templatePath = resolveTemplatePath(context.storagePath, templateKey);
      if (await pathExists(templatePath)) {
        await touchDirectory(templatePath);
        context.log?.("reusing cached template directory");
        return { templateKey };
      }

      const temporaryPath = `${templatePath}.${randomUUID()}.tmp`;
      try {
        await writeResourceTree(
          join(temporaryPath, SKILLS_DIRECTORY_NAME),
          context.resources.skills,
        );
        if (sharedRoot === undefined) {
          const workspaceRoot = join(temporaryPath, WORKSPACE_DIRECTORY_NAME);
          await writeResourceTree(workspaceRoot, context.resources.workspace);
          if (options.prepare !== undefined) {
            context.log?.("running sandbox preparation");
            const template = await openHostSandboxHandle({
              appRoot: context.host.resolveProjectPath("."),
              sessionDirectory: temporaryPath,
              skillRoot: join(temporaryPath, SKILLS_DIRECTORY_NAME),
              workspaceRoot,
            });
            try {
              await options.prepare(
                createLoggingSandboxSession({ log: context.log, session: template.sandbox }),
              );
            } finally {
              await template.onSandboxStop();
            }
          }
        }
        await mkdir(dirname(templatePath), { recursive: true });
        await rename(temporaryPath, templatePath).catch(async (error: unknown) => {
          if (!(await pathExists(templatePath))) throw error;
        });
      } finally {
        await rm(temporaryPath, { force: true, recursive: true });
      }
      return { templateKey };
    },
    async start(context, _openOptions, artifactValue) {
      const artifact = requireHostArtifact(artifactValue);
      const sessionDirectory = resolveSessionDirectory(context);
      if (!(await pathExists(sessionDirectory))) {
        const templatePath = resolveTemplatePath(context.storagePath, artifact.templateKey);
        if (!(await pathExists(templatePath))) {
          throw new SandboxTemplateNotProvisionedError({
            providerName: HOST_PROVIDER_NAME,
            templateKey: templatePath,
          });
        }
        await copyDirectoryAtomically(templatePath, sessionDirectory);
      }
      const root = resolveWorkspaceRoot(context, sessionDirectory);
      await requireDirectory(root);
      return { handle: await openHandle(context, root), state: { root, version: 1 } };
    },
    async resume(context, _artifact, stateValue) {
      const state = requireHostState(stateValue);
      const sessionDirectory = resolveSessionDirectory(context);
      if (state.root !== resolveWorkspaceRoot(context, sessionDirectory)) {
        throw new Error("HostSandbox session state is incompatible with this environment.");
      }
      await requireDirectory(sessionDirectory);
      await requireDirectory(state.root);
      return await openHandle(context, state.root);
    },
    async onSessionEnd(context) {
      await removeHostSessionDirectory(resolveSessionDirectory(context));
    },
  };

  function resolveWorkspaceRoot(
    context: SandboxProviderSessionContext,
    sessionDirectory: string,
  ): string {
    return sharedRoot === undefined
      ? join(sessionDirectory, WORKSPACE_DIRECTORY_NAME)
      : context.host.resolveProjectPath(sharedRoot);
  }

  async function openHandle(context: SandboxProviderSessionContext, root: string) {
    const sessionDirectory = resolveSessionDirectory(context);
    return await openHostSandboxHandle({
      appRoot: context.host.resolveProjectPath("."),
      sessionDirectory,
      skillRoot: join(sessionDirectory, SKILLS_DIRECTORY_NAME),
      workspaceRoot: root,
    });
  }

  // Releasing a keyed call's handle stops its commands; the session directory stays.
  return withToolSessionSandboxes(implementation, {
    releaseHandle: (handle) => handle.onSandboxStop(),
  });
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

async function writeResourceTree(
  directory: string,
  tree: SandboxProviderResourceTree | undefined,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const file of tree?.files ?? []) {
    const path = join(directory, file.relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
}

async function requireDirectory(path: string): Promise<void> {
  const stats = await stat(path).catch(() => undefined);
  if (stats?.isDirectory() !== true) {
    throw new Error(`HostSandbox directory "${path}" does not exist.`);
  }
}

function resolveSessionDirectory(context: SandboxProviderSessionContext): string {
  return resolveLocalProviderSessionRootPath(
    context.storagePath,
    HOST_PROVIDER_NAME,
    createSandboxProviderIdentity({ sessionId: context.session.id, version: 1 }).slice(0, 24),
  );
}

function resolveTemplatePath(storagePath: string, templateKey: string): string {
  return resolveLocalProviderTemplateRootPath(storagePath, HOST_PROVIDER_NAME, templateKey);
}

function requireHostArtifact(artifact: SandboxPreparedArtifact): HostPreparedArtifact {
  if (!isSandboxPreparedArtifactRecord(artifact) || typeof artifact.templateKey !== "string") {
    throw new Error("Invalid prepared HostSandbox artifact.");
  }
  return { templateKey: artifact.templateKey };
}

function requireHostState(state: SandboxPreparedArtifact): HostSessionState {
  if (
    !isSandboxPreparedArtifactRecord(state) ||
    state.version !== 1 ||
    typeof state.root !== "string"
  ) {
    throw new Error("Invalid HostSandbox session state.");
  }
  return { root: state.root, version: 1 };
}
