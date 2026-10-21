import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants, uptime } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import type {
  InternalSandboxBackendContext,
  InternalSandboxBackendInstance,
  SandboxBackendProcess,
} from "#execution/sandbox/backend.js";
import { claimKilledJob, JOB_ROOT_ENV, readJobRecords } from "#execution/sandbox/job-records.js";
import { findEveProjectRoot } from "#internal/eve-project-root.js";
import { MODEL_API_KEY_ENV } from "#internal/model-auth/key-env.js";
import { readDevelopmentEnvironmentValues } from "#shared/development-env-files.js";
import { SANDBOX_SKILL_ROOT_ENV } from "#shared/skill-paths.js";

/** Where the `bash` tool keeps a session's job records; see `execution/sandbox/job-records.ts`. */
const JOBS_DIRECTORY_NAME = "jobs";
const SKILLS_DIRECTORY_NAME = "skills";

/**
 * Process groups each session's commands started, and whether each group's
 * `bash` leader has exited. A group stays here after its leader exits while any
 * member still runs, such as `server > log &`, so stop and delete can still
 * reach it; groups that are no longer ours are dropped (see {@link ownsGroup}).
 */
const groupsBySession = new Map<string, Map<number, { leaderExited: boolean }>>();

/**
 * Opens a host sandbox instance: real `bash` and filesystem in the session's
 * directory. Every command runs in its own process group so abort, stop, and
 * delete can kill whatever it started.
 */
export async function openHostSandboxInstance(
  context: InternalSandboxBackendContext,
): Promise<InternalSandboxBackendInstance> {
  const appRoot = context.resolveProjectPath(".");
  const environmentRoot = (await findEveProjectRoot(appRoot)) ?? appRoot;
  const sessionDirectory = context.directory;
  const jobRoot = join(sessionDirectory, JOBS_DIRECTORY_NAME);
  const skillRoot = join(sessionDirectory, SKILLS_DIRECTORY_NAME);
  // Groups this instance started that may still run, for release.
  const instanceGroups = new Set<number>();
  // Every command this instance launched, never pruned: a `bash` tool job
  // records its launcher's pid, and the launcher exits long before the job.
  const instanceLaunchers = new Set<number>();

  return {
    async exec({ command, cwd, env }) {
      if ((await stat(cwd).catch(() => undefined))?.isDirectory() !== true) {
        throw new Error(`HostSandbox working directory "${cwd}" does not exist.`);
      }
      pruneSessionGroups(sessionDirectory);
      const child = spawn("bash", ["-c", command], {
        cwd,
        detached: true,
        env: {
          ...hostEnvironment(environmentRoot),
          ...env,
          [JOB_ROOT_ENV]: jobRoot,
          [SANDBOX_SKILL_ROOT_ENV]: skillRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const group = child.pid;
      if (group !== undefined) {
        sessionGroups(sessionDirectory).set(group, { leaderExited: false });
        instanceGroups.add(group);
        instanceLaunchers.add(group);
      }
      return adaptProcess(child, () => {
        if (group === undefined) return;
        const tracked = groupsBySession.get(sessionDirectory)?.get(group);
        if (tracked !== undefined) tracked.leaderExited = true;
        if (ownsGroup(group, true)) return;
        groupsBySession.get(sessionDirectory)?.delete(group);
        instanceGroups.delete(group);
      });
    },
    async readFile(path) {
      try {
        return await readFile(path);
      } catch (error) {
        if (isMissingPathError(error)) return null;
        throw error;
      }
    },
    async writeFile(path, content) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    async removePath({ path, force, recursive }) {
      await rm(path, { force, recursive });
    },
    stop() {
      stopHostSessionCommands(sessionDirectory);
    },
    // Stops what this instance started, including `bash` tool jobs it launched,
    // without touching overlapping calls that share the session directory.
    dispose() {
      killJobGroups(jobRoot, instanceLaunchers);
      const groups = groupsBySession.get(sessionDirectory);
      for (const group of instanceGroups) {
        const tracked = groups?.get(group);
        if (tracked !== undefined) killOwnedGroup(group, tracked.leaderExited);
        groups?.delete(group);
      }
      instanceGroups.clear();
    },
  };
}

/** Kills every command and `bash` tool job the session still has running. */
export function stopHostSessionCommands(sessionDirectory: string): void {
  killJobGroups(join(sessionDirectory, JOBS_DIRECTORY_NAME));
  for (const [group, { leaderExited }] of groupsBySession.get(sessionDirectory) ?? []) {
    killOwnedGroup(group, leaderExited);
  }
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
  ...Object.values(MODEL_API_KEY_ENV),
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

function adaptProcess(child: ChildProcess, onClose: () => void): SandboxBackendProcess {
  let closed = false;
  const exited = new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => {
      closed = true;
      resolveExit(code ?? 128 + (signal === null ? 0 : constants.signals[signal]));
    });
  }).finally(onClose);
  return {
    exited,
    stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
    // Once the pipes close this command is done; its group may live on in the session registry.
    kill() {
      if (!closed && child.pid !== undefined) killGroup(child.pid);
    },
  };
}

/**
 * Kills what the `bash` tool's jobs under `jobRoot` still run, optionally only
 * jobs launched by `launchers`. A job that has not exited is claimed with the
 * killed exit code, then its group is killed. A job that has exited may have
 * left background processes in its group, which are killed if the group is
 * still ours.
 *
 * Session directories outlive the eve process, and a group id is reused once
 * its processes are gone, so a job's group is trusted only while it can still
 * name that job: recorded since this boot, and still ours. Claiming the job
 * first means no later stop treats it as running again.
 */
function killJobGroups(jobRoot: string, launchers?: ReadonlySet<number>): void {
  const bootTime = Date.now() - uptime() * 1000;
  for (const job of readJobRecords(jobRoot)) {
    if (launchers !== undefined && !launchers.has(job.launcher ?? -1)) continue;
    const claimed = !job.exited && claimKilledJob(job);
    if (job.recordedAt < bootTime) continue;
    if (claimed) {
      if (isGroupAlive(job.group)) killGroup(job.group);
    } else {
      killOwnedGroup(job.group, true);
    }
  }
}

/**
 * Whether `group` still holds processes we started. While its leader runs, it
 * is ours. Once the leader has exited, the group is ours only while members
 * remain and no process has the leader's pid: a pid is never reused while its
 * process group exists, so a process with that pid means the group emptied and
 * the id now names someone else's group.
 */
function ownsGroup(group: number, leaderExited: boolean): boolean {
  return isGroupAlive(group) && !(leaderExited && processExists(group));
}

function killOwnedGroup(group: number, leaderExited: boolean): void {
  if (ownsGroup(group, leaderExited)) killGroup(group);
}

function pruneSessionGroups(sessionDirectory: string): void {
  const groups = groupsBySession.get(sessionDirectory);
  for (const [group, { leaderExited }] of groups ?? []) {
    if (!ownsGroup(group, leaderExited)) groups?.delete(group);
  }
}

function sessionGroups(sessionDirectory: string): Map<number, { leaderExited: boolean }> {
  let groups = groupsBySession.get(sessionDirectory);
  if (groups === undefined) {
    groups = new Map();
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: a process with this pid exists but belongs to another user.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
