import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";

import { buildSandboxSession, SANDBOX_AGENT_ENV } from "#execution/sandbox/session.js";
import { bufferToStream, streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { findEveProjectRoot } from "#internal/eve-project-root.js";
import { readDevelopmentEnvironmentValues } from "#shared/development-env-files.js";
import type { SandboxProviderHandle } from "#shared/sandbox-provider.js";
import type {
  SandboxProcess,
  SandboxSession,
  SandboxSpawnOptions,
} from "#shared/sandbox-session.js";
import { SANDBOX_SKILL_ROOT_ENV } from "#shared/skill-paths.js";

/** Where the `bash` tool keeps a session's background jobs; see `execution/sandbox/bash.ts`. */
const JOBS_DIRECTORY_NAME = "jobs";

/**
 * Process groups each session's commands started. A group stays here after its
 * `bash` leader exits while any member still runs, such as `server > log &`, so
 * stop and delete can still reach it; groups with no members left are dropped.
 */
const groupsBySession = new Map<string, Set<number>>();

/** Kills only what one handle started, for releasing a keyed tool-session call. */
const handleReleases = new WeakMap<SandboxProviderHandle, () => void>();

/**
 * Opens a host session: real `bash` and filesystem, rooted at `workspaceRoot`.
 * Every command runs in its own process group so abort, stop, and delete can
 * kill whatever it started.
 */
export async function openHostSandboxHandle(input: {
  readonly appRoot: string;
  /** Session-owned directory; deleting the sandbox removes it. */
  readonly sessionDirectory: string;
  readonly skillRoot: string;
  readonly workspaceRoot: string;
}): Promise<SandboxProviderHandle<SandboxSession>> {
  const environmentRoot = (await findEveProjectRoot(input.appRoot)) ?? input.appRoot;
  const jobRoot = join(input.sessionDirectory, JOBS_DIRECTORY_NAME);
  const sessionGroups = sessionGroupSet(input.sessionDirectory);
  const handleGroups = new Set<number>();
  const resolvePath = (path: string) =>
    isAbsolute(path) ? path : resolve(input.workspaceRoot, path);

  const sandbox = buildSandboxSession({
    resolvePath,
    async spawn(options) {
      options.abortSignal?.throwIfAborted();
      const cwd = resolvePath(options.workingDirectory ?? ".");
      if ((await stat(cwd).catch(() => undefined))?.isDirectory() !== true) {
        throw new Error(`HostSandbox working directory "${cwd}" does not exist.`);
      }
      const child = spawn("bash", ["-c", options.command], {
        cwd,
        detached: true,
        env: {
          ...hostEnvironment(environmentRoot),
          ...SANDBOX_AGENT_ENV,
          ...options.env,
          EVE_SANDBOX_JOB_ROOT: jobRoot,
          [SANDBOX_SKILL_ROOT_ENV]: input.skillRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const group = child.pid;
      if (group !== undefined) {
        sessionGroups.add(group);
        handleGroups.add(group);
      }
      return adaptProcess(child, options, () => {
        if (group === undefined || isGroupAlive(group)) return;
        sessionGroups.delete(group);
        handleGroups.delete(group);
      });
    },
    async readFile({ path, abortSignal }) {
      try {
        return bufferToStream(await readFile(path, { signal: abortSignal }));
      } catch (error) {
        if (isMissingPathError(error)) return null;
        throw error;
      }
    },
    async writeFile({ path, content, abortSignal }) {
      const bytes = await streamToBuffer(content);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { signal: abortSignal });
    },
    async removePath({ path, force, recursive }) {
      await rm(path, { force, recursive });
    },
  });

  const handle: SandboxProviderHandle<SandboxSession> = {
    sandbox,
    async onRuntimeShutdown() {
      stopHostSessionCommands(input.sessionDirectory);
    },
    async onSandboxDelete() {
      await removeHostSessionDirectory(input.sessionDirectory);
    },
    async onSandboxStop() {
      stopHostSessionCommands(input.sessionDirectory);
    },
  };
  handleReleases.set(handle, () => {
    killJobGroups(jobRoot, handleGroups);
    for (const group of handleGroups) {
      killGroup(group);
      sessionGroups.delete(group);
    }
    handleGroups.clear();
  });
  return handle;
}

/**
 * Stops what one handle started, including `bash` tool jobs it launched,
 * without touching overlapping calls that share the session directory.
 */
export function releaseHostSandboxHandle(handle: SandboxProviderHandle): void {
  handleReleases.get(handle)?.();
}

/** Kills every command and `bash` tool job the session still has running. */
export function stopHostSessionCommands(sessionDirectory: string): void {
  killJobGroups(join(sessionDirectory, JOBS_DIRECTORY_NAME));
  for (const group of groupsBySession.get(sessionDirectory) ?? []) killGroup(group);
  groupsBySession.delete(sessionDirectory);
}

/** Kills every command of the session, then removes its eve-owned directory. */
export async function removeHostSessionDirectory(sessionDirectory: string): Promise<void> {
  stopHostSessionCommands(sessionDirectory);
  await rm(sessionDirectory, { force: true, recursive: true });
}

/**
 * Variables eve sets for its own runtime after launch, and the model
 * credentials that belong to the eve agent rather than the workspace.
 */
const EVE_RUNTIME_ENV_NAMES = new Set([
  "AI_GATEWAY_API_KEY",
  "EVE_BASE_URL",
  "EVE_DEV",
  "EVE_EVALUATION",
  "PORT",
  "VERCEL_OIDC_TOKEN",
]);
const EVE_RUNTIME_ENV_PREFIXES = [
  "EVE_DEV_",
  "EVE_DEVELOPMENT_",
  "EVE_EVALUATION_",
  "EVE_MODEL_",
  "NITRO_",
  "WORKFLOW_",
];

/**
 * The environment eve was launched with, minus eve's runtime variables and the
 * values it loaded from development env files. Re-reading the files at spawn
 * keeps this right across env-file reloads and the dev server's process
 * boundary; a key whose value differs from the file came from the shell and
 * stays.
 */
function hostEnvironment(environmentRoot: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      EVE_RUNTIME_ENV_NAMES.has(key) ||
      EVE_RUNTIME_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      delete environment[key];
    }
  }
  for (const [key, value] of readDevelopmentEnvironmentValues(environmentRoot)) {
    if (environment[key] === value) delete environment[key];
  }
  return environment;
}

function adaptProcess(
  child: ChildProcess,
  options: SandboxSpawnOptions,
  onClose: () => void,
): SandboxProcess {
  let closed = false;
  // Once the pipes close this command is done; its group may live on in the session registry.
  const kill = () => {
    if (!closed && child.pid !== undefined) killGroup(child.pid);
  };
  options.abortSignal?.addEventListener("abort", kill, { once: true });

  const exit = new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => {
      closed = true;
      if (options.abortSignal?.aborted) rejectExit(options.abortSignal.reason);
      else resolveExit(code ?? 128 + (signal === null ? 0 : constants.signals[signal]));
    });
  }).finally(() => {
    options.abortSignal?.removeEventListener("abort", kill);
    onClose();
  });
  // Surface spawn and abort failures through `wait()`, not as unhandled rejections.
  exit.catch(() => {});

  return {
    pid: child.pid,
    stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
    async wait() {
      return { exitCode: await exit };
    },
    async kill() {
      kill();
      await exit.catch(() => {});
    },
  };
}

/**
 * Kills the process group of every `bash` tool job under `jobRoot` that has
 * not written its exit code, optionally only jobs launched by `launchers`. The
 * launcher records its own pid, which is the pid of the command that ran it.
 */
function killJobGroups(jobRoot: string, launchers?: ReadonlySet<number>): void {
  let jobs: string[];
  try {
    jobs = readdirSync(jobRoot);
  } catch {
    return;
  }
  for (const job of jobs) {
    const directory = join(jobRoot, job);
    if (existsSync(join(directory, "exit"))) continue;
    const group = readPid(join(directory, "pid"));
    if (group === undefined) continue;
    if (launchers !== undefined && !launchers.has(readPid(join(directory, "launcher")) ?? -1)) {
      continue;
    }
    killGroup(group);
  }
}

function readPid(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function sessionGroupSet(sessionDirectory: string): Set<number> {
  let groups = groupsBySession.get(sessionDirectory);
  if (groups === undefined) {
    groups = new Set();
    groupsBySession.set(sessionDirectory, groups);
  }
  return groups;
}

// Signals target the negative pid: the command's whole process group.
function killGroup(group: number): void {
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // ESRCH: the group is gone. EPERM: the id now belongs to another user.
  }
}

function isGroupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
