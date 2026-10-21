import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  openHostSandboxHandle,
  releaseHostSandboxHandle,
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
import { HOST_PROVIDER_NAME } from "#execution/sandbox/host-provider-name.js";
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

export { HOST_PROVIDER_NAME };

const WORKSPACE_DIRECTORY_NAME = "workspace";
const SKILLS_DIRECTORY_NAME = "skills";
const AUTHORED_SKILLS_MARKER = "authored-skills.json";
const RECURSIVE = { force: true, recursive: true } as const;

// Holds the template key, not its path: the build and runtime app roots can differ.
type HostPreparedArtifact = { readonly templateKey: string };
type HostSessionState = { readonly root: string; readonly version: 1 };

/**
 * Creates the host provider. A template directory holds the skills and, in
 * per-session mode, the seeded workspace. Each session owns a directory derived
 * from its session id, so keyed tool sessions and resume find it again: the
 * workspace is copied in once, and each template generation gets its own copy
 * of the skills, so a rebuild's skills reach existing sessions too. A shared
 * `root` is used in place and never seeded or deleted.
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
    // An upsert on the session id: the template seeds the workspace only when
    // this call creates it, and concurrent creators race on an atomic rename.
    async start(context, _openOptions, artifactValue) {
      const artifact = requireHostArtifact(artifactValue);
      const root = resolveWorkspaceRoot(context);
      if (sharedRoot === undefined && !(await pathExists(root))) {
        const templatePath = await requireTemplate(context, artifact);
        await copyDirectoryAtomically(join(templatePath, WORKSPACE_DIRECTORY_NAME), root);
      }
      await requireDirectory(root);
      return { handle: await openHandle(context, artifact, root), state: { root, version: 1 } };
    },
    async resume(context, artifactValue, stateValue) {
      const artifact = requireHostArtifact(artifactValue);
      const state = requireHostState(stateValue);
      if (state.root !== resolveWorkspaceRoot(context)) {
        throw new Error("HostSandbox session state is incompatible with this environment.");
      }
      await requireDirectory(state.root);
      return await openHandle(context, artifact, state.root);
    },
    // The session directory comes from the key, so `state` is not needed; a
    // shared root lives outside it and is never removed.
    async onSessionEnd(context) {
      await removeHostSessionDirectory(resolveSessionDirectory(context));
    },
  };

  function resolveWorkspaceRoot(context: SandboxProviderSessionContext): string {
    return sharedRoot === undefined
      ? join(resolveSessionDirectory(context), WORKSPACE_DIRECTORY_NAME)
      : context.host.resolveProjectPath(sharedRoot);
  }

  async function openHandle(
    context: SandboxProviderSessionContext,
    artifact: HostPreparedArtifact,
    root: string,
  ) {
    const sessionDirectory = resolveSessionDirectory(context);
    const skillRoot = join(sessionDirectory, SKILLS_DIRECTORY_NAME);
    await refreshAuthoredSkills({ artifact, context, sessionDirectory, skillRoot });
    return await openHostSandboxHandle({
      appRoot: context.host.resolveProjectPath("."),
      sessionDirectory,
      skillRoot,
      workspaceRoot: root,
    });
  }

  // Releasing a keyed call's handle stops what it started; the session directory stays.
  return withToolSessionSandboxes(implementation, {
    releaseHandle: async (handle) => releaseHostSandboxHandle(handle),
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

/** Records which template generation last wrote the session's authored skills. */
interface AuthoredSkillsMarker {
  readonly skills: readonly string[];
  readonly templateKey: string;
}

/**
 * Brings the session's authored skills up to the current template generation.
 * Dynamic skills share the directory and persist across rebuilds, so only the
 * authored skill directories are replaced, and only those the previous
 * generation wrote are removed.
 */
async function refreshAuthoredSkills(input: {
  readonly artifact: HostPreparedArtifact;
  readonly context: SandboxProviderSessionContext;
  readonly sessionDirectory: string;
  readonly skillRoot: string;
}): Promise<void> {
  const markerPath = join(input.sessionDirectory, AUTHORED_SKILLS_MARKER);
  const previous = await readAuthoredSkillsMarker(markerPath);
  if (previous?.templateKey === input.artifact.templateKey) return;

  const templatePath = resolveTemplatePath(input.context.storagePath, input.artifact.templateKey);
  // An existing session keeps its skills when this generation's template is gone.
  if (previous !== undefined && !(await pathExists(templatePath))) return;
  const templateSkills = join(
    await requireTemplate(input.context, input.artifact),
    SKILLS_DIRECTORY_NAME,
  );
  const skills = await readdir(templateSkills).catch((): string[] => []);
  for (const name of previous?.skills ?? []) {
    if (!skills.includes(name)) await rm(join(input.skillRoot, name), RECURSIVE);
  }
  for (const name of skills) {
    await rm(join(input.skillRoot, name), RECURSIVE);
    await copyDirectoryAtomically(join(templateSkills, name), join(input.skillRoot, name));
  }
  await mkdir(input.skillRoot, { recursive: true });
  const marker: AuthoredSkillsMarker = { skills, templateKey: input.artifact.templateKey };
  await writeFile(markerPath, JSON.stringify(marker));
}

async function readAuthoredSkillsMarker(path: string): Promise<AuthoredSkillsMarker | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "templateKey" in value &&
      typeof value.templateKey === "string" &&
      "skills" in value &&
      Array.isArray(value.skills) &&
      value.skills.every((name: unknown) => typeof name === "string")
    ) {
      return { skills: value.skills, templateKey: value.templateKey };
    }
  } catch {
    // A missing or unreadable marker means no generation has written skills yet.
  }
  return undefined;
}

async function requireTemplate(
  context: SandboxProviderSessionContext,
  artifact: HostPreparedArtifact,
): Promise<string> {
  const templatePath = resolveTemplatePath(context.storagePath, artifact.templateKey);
  if (!(await pathExists(templatePath))) {
    throw new SandboxTemplateNotProvisionedError({
      providerName: HOST_PROVIDER_NAME,
      templateKey: templatePath,
    });
  }
  return templatePath;
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
