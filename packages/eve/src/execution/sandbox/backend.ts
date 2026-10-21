import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";

import {
  copyDirectoryAtomically,
  pathExists,
  resolveLocalProviderSessionRootPath,
  resolveLocalProviderTemplateRootPath,
  touchDirectory,
} from "#execution/sandbox/bindings/local-provider-utils.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { createSandboxProviderIdentity } from "#execution/sandbox/provider-identity.js";
import { buildSandboxSession, SANDBOX_AGENT_ENV } from "#execution/sandbox/session.js";
import { bufferToStream, streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { withToolSessionSandboxes } from "#execution/tool-session/sandbox.js";
import type { SandboxSelectorContext } from "#shared/sandbox-environment.js";
import {
  defineSandboxProvider,
  isSandboxPreparedArtifactRecord,
  sandboxProviderResourceIdentity,
  type SandboxPreparedArtifact,
  type SandboxProvider,
  type SandboxProviderHandle,
  type SandboxProviderImplementation,
  type SandboxProviderResourceTree,
  type SandboxProviderSessionContext,
} from "#shared/sandbox-provider.js";
import type { SandboxProcess, SandboxSession } from "#shared/sandbox-session.js";
import { SandboxSessionGoneError } from "#shared/sandbox-session-gone-error.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import { shellQuote } from "#shared/shell-quote.js";
import { resolveSandboxSkillRoot } from "#shared/skill-paths.js";

type MaybePromise<T> = T | Promise<T>;

/** Where eve keeps a session's sandbox, passed to every {@link SandboxBackendDefinition} hook. */
export interface SandboxBackendContext {
  /**
   * The session's sandbox directory under the app's sandbox cache. eve owns it:
   * the default `remove` deletes it, and a backend without `find` treats the
   * sandbox as gone when it is missing. eve creates its parent, and creates the
   * directory itself only for a `directoryTemplate` backend.
   */
  readonly directory: string;
  /**
   * A stable id for the session's sandbox, unique per app and session, built
   * from lowercase letters, digits, and hyphens. Every open for the session
   * gets the same key, so it can name a container or VM to find again.
   */
  readonly key: string;
  /** Resolves a path relative to the app root. */
  resolveProjectPath(path: string): string;
  /** The session the sandbox belongs to; absent while eve prepares a `directoryTemplate`. */
  readonly session: SandboxSelectorContext["session"] | undefined;
}

/** One shell command for {@link SandboxBackendInstance.exec}. */
export interface SandboxBackendExecOptions {
  /** The command, run by `bash -c` or an equivalent shell. */
  readonly command: string;
  /** Absolute working directory, the workspace root unless the caller chose another. */
  readonly cwd: string;
  /** Variables to add to the command's environment, including `AI_AGENT=eve`. */
  readonly env: Readonly<Record<string, string>>;
  /** Aborted when the caller cancels the command. */
  readonly signal?: AbortSignal;
}

/** Command output or file content, as text or bytes. */
export type SandboxBackendData = string | Uint8Array;

/** Command output delivered while the command runs. */
export type SandboxBackendDataStream =
  | AsyncIterable<SandboxBackendData>
  | ReadableStream<SandboxBackendData>;

/** The result of a command that ran to completion. */
export interface SandboxBackendExecResult {
  readonly exitCode: number;
  readonly stderr: SandboxBackendData;
  readonly stdout: SandboxBackendData;
}

/** A running command whose output streams, and which eve can kill on abort. */
export interface SandboxBackendProcess {
  /** Resolves with the exit code once the command finishes. */
  readonly exited: Promise<number>;
  readonly stderr: SandboxBackendDataStream;
  readonly stdout: SandboxBackendDataStream;
  /** Stops the command; eve calls it when the command's signal aborts. */
  kill(): MaybePromise<void>;
}

/**
 * The sandbox a backend opened for one session. eve builds the full
 * `SandboxSession` from these operations, resolving every path first:
 * relative paths start at the backend's `workspaceRoot`.
 */
export interface SandboxBackendInstance {
  /**
   * Runs one shell command. Return a {@link SandboxBackendExecResult} once it
   * finishes, or a {@link SandboxBackendProcess} to stream its output and let
   * eve kill it on abort.
   */
  exec(
    options: SandboxBackendExecOptions,
  ): MaybePromise<SandboxBackendExecResult | SandboxBackendProcess>;
  /** Releases this instance without stopping the sandbox, after a keyed `invokeTool` call. */
  dispose?(): MaybePromise<void>;
  /** Returns a file's content, or `null` when it does not exist. */
  readFile(path: string): MaybePromise<SandboxBackendData | null>;
  /** Removes a file or directory. Defaults to running `rm` through `exec`. */
  removePath?(options: {
    readonly force: boolean;
    readonly path: string;
    readonly recursive: boolean;
  }): MaybePromise<void>;
  /** Stops the sandbox's compute, for `sandbox.stop()`, `sandbox.delete()`, and server shutdown. */
  stop?(): MaybePromise<void>;
  /** Writes a file, creating its parent directories. */
  writeFile(path: string, content: Uint8Array): MaybePromise<void>;
}

/**
 * Describes a sandbox engine to {@link defineSandboxBackend}. The backend only
 * opens, finds, and removes its engine's sandbox for a session; eve provides
 * the rest of the sandbox provider contract.
 */
export interface SandboxBackendDefinition<Options extends object = Record<never, never>> {
  /**
   * Prepare a template directory once per build instead of seeding each
   * sandbox. eve writes the workspace files and skills into a template opened
   * with `open`, runs `prepare` there, and copies the result into
   * `context.directory` before the first `open` of each session. Use it for
   * engines whose whole state lives in `context.directory`.
   */
  readonly directoryTemplate?: boolean;
  /**
   * Finds the session's existing sandbox when eve resumes it. Return
   * `undefined` when it no longer exists: eve then starts a fresh one. Without
   * `find`, eve reopens with `open` while `context.directory` exists.
   */
  find?(
    context: SandboxBackendContext,
    options: Readonly<Options>,
  ): Promise<SandboxBackendInstance | undefined>;
  /**
   * Lets `invokeTool` calls with a `key` keep this backend's sandbox between
   * calls. Those sandboxes never reach session end, so nothing removes them;
   * enable it only when they stay cheap, such as directories on local disk.
   */
  readonly keyedToolSessions?: boolean;
  /** The provider name, made of lowercase letters, digits, and hyphens. */
  readonly name: string;
  /**
   * Finds or creates the session's sandbox. Concurrent calls for the same
   * session, even from separate processes, must end up with the same sandbox.
   * Set `created` when this call created it: eve then writes the workspace
   * files and skills and runs the environment's `prepare`, and removes the
   * sandbox if that fails.
   */
  open(
    context: SandboxBackendContext,
    options: Readonly<Options>,
  ): Promise<{ readonly created?: boolean; readonly instance: SandboxBackendInstance }>;
  /**
   * Removes the session's sandbox when the session ends or the agent deletes
   * it. It must succeed when nothing exists. Defaults to deleting
   * `context.directory`.
   */
  remove?(context: SandboxBackendContext, options: Readonly<Options>): Promise<void>;
  /**
   * The absolute path where commands start and relative paths resolve, such
   * as `/workspace`. eve writes the agent's workspace files under it.
   */
  readonly workspaceRoot:
    | string
    | ((context: SandboxBackendContext, options: Readonly<Options>) => string);
}

/** The options a backend's `environment()` accepts: the backend's own, plus `prepare`. */
export type SandboxBackendEnvironmentOptions<Options extends object = Record<never, never>> =
  Options & {
    /**
     * Runs against each new sandbox after eve writes its workspace files and
     * skills, or once per build against a `directoryTemplate`.
     */
    readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
  };

/** The prepared artifact of a backend: its template's cache key. */
export type SandboxBackendArtifact = { readonly templateKey: string };

/** The session state of a backend: the sandbox key, so resume can check it. */
export type SandboxBackendState = { readonly key: string; readonly version: 1 };

const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const RESOURCES_DIRECTORY_NAME = "resources";
const TEMPLATE_DIRECTORY_NAME = "sandbox";
const SKILLS_MARKER_NAME = ".eve-authored-skills.json";

/**
 * Defines a sandbox provider from a backend that only opens, finds, and
 * removes its engine's sandbox for a session. eve owns the rest of the
 * provider contract: it derives a stable key and directory per session,
 * writes workspace files and skills into new sandboxes, runs `prepare`,
 * normalizes commands and file access into a `SandboxSession`, sets
 * `AI_AGENT=eve`, and stops, removes, and resumes the sandbox. Use
 * `defineSandboxProvider` instead for full control, such as snapshots or
 * network policies.
 *
 * @example
 * ```ts
 * export const MySandbox = defineSandboxBackend({
 *   name: "my-engine",
 *   workspaceRoot: "/workspace",
 *   async open(ctx) {
 *     const { sandbox, created } = await engine.findOrCreate(ctx.key);
 *     return { created, instance: sandbox };
 *   },
 *   find: (ctx) => engine.find(ctx.key),
 *   remove: (ctx) => engine.remove(ctx.key),
 * });
 * ```
 */
export function defineSandboxBackend<Options extends object = Record<never, never>>(
  definition: SandboxBackendDefinition<Options>,
): SandboxProvider<SandboxBackendEnvironmentOptions<Options>, undefined, SandboxSession> {
  return defineSandboxProvider<
    SandboxBackendEnvironmentOptions<Options>,
    undefined,
    SandboxBackendArtifact,
    SandboxBackendState
  >({
    name: definition.name,
    environment: (...args) =>
      createSandboxBackendImplementation(
        definition,
        (args[0] ?? {}) as SandboxBackendEnvironmentOptions<Options>,
      ),
  });
}

/** The provider implementation for one backend environment. */
export function createSandboxBackendImplementation<Options extends object>(
  definition: SandboxBackendDefinition<Options>,
  options: SandboxBackendEnvironmentOptions<Options>,
): SandboxProviderImplementation<
  undefined,
  SandboxBackendArtifact,
  SandboxBackendState,
  SandboxSession
> {
  if (!PROVIDER_NAME_PATTERN.test(definition.name)) {
    throw new Error(
      `Sandbox backend name "${definition.name}" must use lowercase letters, digits, and hyphens.`,
    );
  }
  const name = definition.name;
  const instances = new WeakMap<SandboxProviderHandle, SandboxBackendInstance>();

  function sessionContext(context: SandboxProviderSessionContext): SandboxBackendContext {
    const sessionKey = createSandboxProviderIdentity({
      sessionId: context.session.id,
      version: 1,
    }).slice(0, 24);
    return {
      directory: resolveLocalProviderSessionRootPath(context.storagePath, name, sessionKey),
      key: `eve-${name}-${createSandboxProviderIdentity({
        sessionId: context.session.id,
        storagePath: context.storagePath,
        version: 1,
      }).slice(0, 24)}`,
      resolveProjectPath: (path) => context.host.resolveProjectPath(path),
      session: context.session,
    };
  }

  function workspaceRoot(context: SandboxBackendContext): string {
    return typeof definition.workspaceRoot === "string"
      ? definition.workspaceRoot
      : definition.workspaceRoot(context, options);
  }

  async function remove(context: SandboxBackendContext): Promise<void> {
    if (definition.remove !== undefined) await definition.remove(context, options);
    else await rm(context.directory, { force: true, recursive: true });
  }

  /** Brings a new sandbox up to the build: workspace files, then skills, then `prepare`. */
  async function initialize(input: {
    readonly context: SandboxBackendContext;
    readonly instance: SandboxBackendInstance;
    readonly log?: (message: string) => void;
    readonly sandbox: SandboxSession;
    readonly templatePath: string;
    readonly templateKey: string;
  }): Promise<void> {
    const resources = join(input.templatePath, RESOURCES_DIRECTORY_NAME);
    const root = workspaceRoot(input.context);
    for (const file of await listFiles(join(resources, "workspace"))) {
      await input.instance.writeFile(
        posix.join(root, file.relativePath),
        await readFile(file.path),
      );
    }
    await refreshAuthoredSkills({ ...input, name, resources });
    if (options.prepare !== undefined) {
      input.log?.("running sandbox preparation");
      await options.prepare(
        createLoggingSandboxSession({ log: input.log, session: input.sandbox }),
      );
    }
  }

  function createHandle(
    context: SandboxBackendContext,
    instance: SandboxBackendInstance,
    sandbox: SandboxSession,
  ): SandboxProviderHandle<SandboxSession> {
    const handle: SandboxProviderHandle<SandboxSession> = {
      sandbox,
      async onRuntimeShutdown() {
        await instance.stop?.();
      },
      async onSandboxDelete() {
        await instance.stop?.();
        await remove(context);
      },
      async onSandboxStop() {
        await instance.stop?.();
      },
    };
    instances.set(handle, instance);
    return handle;
  }

  const implementation: ReturnType<typeof createSandboxBackendImplementation<Options>> = {
    async prepare(context) {
      const templateKey = createSandboxProviderIdentity({
        directoryTemplate: definition.directoryTemplate === true,
        name,
        options: JSON.stringify(options, (_key, value: unknown) =>
          typeof value === "function" ? undefined : value,
        ),
        resources: sandboxProviderResourceIdentity(context.resources),
        sourceRevision: context.sourceRevision,
        version: 1,
      }).slice(0, 24);
      const templatePath = resolveLocalProviderTemplateRootPath(
        context.storagePath,
        name,
        templateKey,
      );
      if (await pathExists(templatePath)) {
        await touchDirectory(templatePath);
        context.log?.("reusing cached template directory");
        return { templateKey };
      }

      const draft = `${templatePath}.${randomUUID()}.tmp`;
      try {
        await writeResourceTree(
          join(draft, RESOURCES_DIRECTORY_NAME, "workspace"),
          context.resources.workspace,
        );
        await writeResourceTree(
          join(draft, RESOURCES_DIRECTORY_NAME, "skills"),
          context.resources.skills,
        );
        if (definition.directoryTemplate === true) {
          const backendContext: SandboxBackendContext = {
            directory: join(draft, TEMPLATE_DIRECTORY_NAME),
            key: `eve-${name}-template-${templateKey}`,
            resolveProjectPath: (path) => context.host.resolveProjectPath(path),
            session: undefined,
          };
          await mkdir(backendContext.directory, { recursive: true });
          const { instance } = await definition.open(backendContext, options);
          try {
            await initialize({
              context: backendContext,
              instance,
              log: context.log,
              sandbox: createBackendSession(instance, workspaceRoot(backendContext)),
              templateKey,
              templatePath: draft,
            });
          } finally {
            await instance.stop?.();
          }
        }
        await mkdir(dirname(templatePath), { recursive: true });
        await rename(draft, templatePath).catch(async (error: unknown) => {
          if (!(await pathExists(templatePath))) throw error;
        });
      } finally {
        await rm(draft, { force: true, recursive: true });
      }
      return { templateKey };
    },

    async start(providerContext, _openOptions, artifactValue) {
      const { templateKey } = requireArtifact(name, artifactValue);
      const context = sessionContext(providerContext);
      const templatePath = resolveLocalProviderTemplateRootPath(
        providerContext.storagePath,
        name,
        templateKey,
      );
      await mkdir(dirname(context.directory), { recursive: true });
      if (definition.directoryTemplate === true && !(await pathExists(context.directory))) {
        await requireTemplate(name, templatePath);
        await copyDirectoryAtomically(
          join(templatePath, TEMPLATE_DIRECTORY_NAME),
          context.directory,
        );
      }
      const { created, instance } = await definition.open(context, options);
      const sandbox = createBackendSession(instance, workspaceRoot(context));
      const seed = created === true && definition.directoryTemplate !== true;
      try {
        if (seed) {
          await requireTemplate(name, templatePath);
          await initialize({ context, instance, sandbox, templateKey, templatePath });
        } else {
          await refreshAuthoredSkills({
            instance,
            name,
            resources: join(templatePath, RESOURCES_DIRECTORY_NAME),
            sandbox,
            templateKey,
          });
        }
      } catch (error) {
        // A half-seeded sandbox must not be found again by a later open.
        if (seed) {
          await Promise.resolve(instance.stop?.()).catch(() => {});
          await remove(context).catch(() => {});
        }
        throw error;
      }
      return {
        handle: createHandle(context, instance, sandbox),
        state: { key: context.key, version: 1 },
      };
    },

    async resume(providerContext, artifactValue, stateValue) {
      const { templateKey } = requireArtifact(name, artifactValue);
      const context = sessionContext(providerContext);
      if (requireState(name, stateValue).key !== context.key) {
        throw new Error(
          `Sandbox backend "${name}" session state is incompatible with this session.`,
        );
      }
      const instance =
        definition.find !== undefined
          ? await definition.find(context, options)
          : (await pathExists(context.directory))
            ? (await definition.open(context, options)).instance
            : undefined;
      if (instance === undefined) {
        throw new SandboxSessionGoneError(
          `The "${name}" sandbox for this session no longer exists.`,
        );
      }
      const sandbox = createBackendSession(instance, workspaceRoot(context));
      await refreshAuthoredSkills({
        instance,
        name,
        resources: join(
          resolveLocalProviderTemplateRootPath(providerContext.storagePath, name, templateKey),
          RESOURCES_DIRECTORY_NAME,
        ),
        sandbox,
        templateKey,
      });
      return createHandle(context, instance, sandbox);
    },

    async onSessionEnd(providerContext) {
      await remove(sessionContext(providerContext));
    },
  };

  if (definition.keyedToolSessions !== true) return implementation;
  return withToolSessionSandboxes(implementation, {
    releaseHandle: async (handle) => {
      await instances.get(handle)?.dispose?.();
    },
  });
}

/** Builds the full session from a backend instance, anchoring relative paths at `root`. */
function createBackendSession(instance: SandboxBackendInstance, root: string): SandboxSession {
  const resolvePath = (path: string) => (path.startsWith("/") ? path : posix.resolve(root, path));
  const session = buildSandboxSession({
    resolvePath,
    async spawn(options) {
      options.abortSignal?.throwIfAborted();
      return spawnBackendCommand(instance, {
        command: options.command,
        cwd: resolvePath(options.workingDirectory ?? "."),
        env: { ...SANDBOX_AGENT_ENV, ...options.env },
        signal: options.abortSignal,
      });
    },
    async readFile({ path }) {
      const content = await instance.readFile(path);
      return content === null ? null : bufferToStream(toBytes(content));
    },
    async writeFile({ path, content }) {
      await instance.writeFile(path, new Uint8Array(await streamToBuffer(content)));
    },
    async removePath({ force = false, path, recursive = false }) {
      if (instance.removePath !== undefined) {
        await instance.removePath({ force, path, recursive });
        return;
      }
      const flags = `${force ? "f" : ""}${recursive ? "r" : ""}`;
      const result = await session.run({
        command: `rm ${flags === "" ? "" : `-${flags} `}-- ${shellQuote(path)}`,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Could not remove "${path}": ${result.stderr.trim()}`);
      }
    },
  });
  return session;
}

/**
 * Starts a command without waiting for it: a backend that returns a finished
 * result only resolves once the command exits, so output and the exit code
 * are read lazily.
 */
function spawnBackendCommand(
  instance: SandboxBackendInstance,
  options: SandboxBackendExecOptions,
): SandboxProcess {
  const pending = Promise.resolve().then(() => instance.exec(options));
  const kill = async () => {
    const result = await pending.catch(() => undefined);
    if (result !== undefined && isBackendProcess(result)) await result.kill();
  };
  const onAbort = () => void kill().catch(() => {});
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const exit = pending
    .then((result) => (isBackendProcess(result) ? result.exited : result.exitCode))
    .finally(() => options.signal?.removeEventListener("abort", onAbort));
  // Failures surface through `wait()` and the output streams, not as unhandled rejections.
  exit.catch(() => {});
  return {
    stdout: lazyByteStream(pending.then((result) => result.stdout)),
    stderr: lazyByteStream(pending.then((result) => result.stderr)),
    async wait() {
      const exitCode = await exit;
      if (options.signal?.aborted) throw options.signal.reason;
      return { exitCode };
    },
    async kill() {
      await kill();
      await exit.catch(() => {});
    },
  };
}

function isBackendProcess(
  result: SandboxBackendExecResult | SandboxBackendProcess,
): result is SandboxBackendProcess {
  return "exited" in result;
}

function lazyByteStream(
  source: Promise<SandboxBackendData | SandboxBackendDataStream>,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= toByteStream(await source).getReader();
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}

function toByteStream(
  source: SandboxBackendData | SandboxBackendDataStream,
): ReadableStream<Uint8Array> {
  if (typeof source === "string" || source instanceof Uint8Array) {
    return bufferToStream(toBytes(source));
  }
  if (source instanceof ReadableStream) {
    return source.pipeThrough(
      new TransformStream<SandboxBackendData, Uint8Array>({
        transform: (chunk, controller) => controller.enqueue(toBytes(chunk)),
      }),
    );
  }
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done === true) controller.close();
      else controller.enqueue(toBytes(next.value));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function toBytes(data: SandboxBackendData): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

/** Records which build last wrote the sandbox's authored skills. */
interface AuthoredSkillsMarker {
  readonly skills: readonly string[];
  readonly templateKey: string;
}

/**
 * Brings the sandbox's authored skills up to the current build. Dynamic
 * skills share the skill root and persist across rebuilds, so only the
 * authored skill directories are replaced, and only those the previous build
 * wrote are removed. The marker sits beside the skill root, not in it.
 */
async function refreshAuthoredSkills(input: {
  readonly name: string;
  readonly instance: SandboxBackendInstance;
  readonly resources: string;
  readonly sandbox: SandboxSession;
  readonly templateKey: string;
}): Promise<void> {
  const skillRoot = await resolveSandboxSkillRoot({ sandbox: input.sandbox });
  const markerPath = posix.join(posix.dirname(skillRoot), SKILLS_MARKER_NAME);
  const previous = parseSkillsMarker(await input.instance.readFile(markerPath));
  if (previous?.templateKey === input.templateKey) return;
  // An existing sandbox keeps its skills when this build's template was pruned.
  if (!(await pathExists(input.resources))) {
    if (previous !== undefined) return;
    throw new SandboxTemplateNotProvisionedError({
      providerName: input.name,
      templateKey: input.resources,
    });
  }
  const skillsDirectory = join(input.resources, "skills");
  const skills = await readdir(skillsDirectory).catch((): string[] => []);
  for (const skill of previous?.skills ?? []) {
    if (!skills.includes(skill)) {
      await input.sandbox.removePath({
        force: true,
        path: posix.join(skillRoot, skill),
        recursive: true,
      });
    }
  }
  for (const skill of skills) {
    await input.sandbox.removePath({
      force: true,
      path: posix.join(skillRoot, skill),
      recursive: true,
    });
    for (const file of await listFiles(join(skillsDirectory, skill))) {
      await input.instance.writeFile(
        posix.join(skillRoot, skill, file.relativePath),
        await readFile(file.path),
      );
    }
  }
  const marker: AuthoredSkillsMarker = { skills, templateKey: input.templateKey };
  await input.instance.writeFile(markerPath, new TextEncoder().encode(JSON.stringify(marker)));
}

function parseSkillsMarker(content: SandboxBackendData | null): AuthoredSkillsMarker | undefined {
  if (content === null) return undefined;
  try {
    const value: unknown = JSON.parse(
      typeof content === "string" ? content : new TextDecoder().decode(content),
    );
    if (
      isSandboxPreparedArtifactRecord(value) &&
      typeof value.templateKey === "string" &&
      Array.isArray(value.skills) &&
      value.skills.every((skill) => typeof skill === "string")
    ) {
      return { skills: value.skills, templateKey: value.templateKey };
    }
  } catch {
    // An unreadable marker means no build has written skills yet.
  }
  return undefined;
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

/** Every file under `directory`, with its path relative to it in POSIX form. */
async function listFiles(
  directory: string,
): Promise<{ readonly path: string; readonly relativePath: string }[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path, relativePath: relative(directory, path).split("\\").join("/") };
    });
}

async function requireTemplate(name: string, templatePath: string): Promise<void> {
  if (!(await pathExists(templatePath))) {
    throw new SandboxTemplateNotProvisionedError({ providerName: name, templateKey: templatePath });
  }
}

function requireArtifact(name: string, artifact: SandboxPreparedArtifact): SandboxBackendArtifact {
  if (!isSandboxPreparedArtifactRecord(artifact) || typeof artifact.templateKey !== "string") {
    throw new Error(`Invalid prepared artifact for sandbox backend "${name}".`);
  }
  return { templateKey: artifact.templateKey };
}

function requireState(name: string, state: SandboxPreparedArtifact): SandboxBackendState {
  if (
    !isSandboxPreparedArtifactRecord(state) ||
    state.version !== 1 ||
    typeof state.key !== "string"
  ) {
    throw new Error(`Invalid session state for sandbox backend "${name}".`);
  }
  return { key: state.key, version: 1 };
}
