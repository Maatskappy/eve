import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants, uptime } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import type {
  InternalSandboxBackendContext,
  InternalSandboxBackendInstance,
  SandboxBackendProcess,
} from "#execution/sandbox/backend.js";
import { findEveProjectRoot } from "#internal/eve-project-root.js";
import { readDevelopmentEnvironmentValues } from "#shared/development-env-files.js";
import { SANDBOX_SKILL_ROOT_ENV } from "#shared/skill-paths.js";

/** Where the `bash` tool keeps a session's background jobs; see `execution/sandbox/bash.ts`. */
const JOBS_DIRECTORY_NAME = "jobs";
const SKILLS_DIRECTORY_NAME = "skills";

/**
 * Process groups each session's commands started. A group stays here after its
 * `bash` leader exits while any member still runs, such as `server > log &`, so
 * stop and delete can still reach it; groups with no members left are dropped.
 */
const groupsBySession = new Map<string, Set<number>>();

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
      const child = spawn("bash", ["-c", command], {
        cwd,
        detached: true,
        env: {
          ...hostEnvironment(environmentRoot),
          ...env,
          EVE_SANDBOX_JOB_ROOT: jobRoot,
          [SANDBOX_SKILL_ROOT_ENV]: skillRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const group = child.pid;
      if (group !== undefined) {
        sessionGroupSet(sessionDirectory).add(group);
        instanceGroups.add(group);
        instanceLaunchers.add(group);
      }
      return adaptProcess(child, () => {
        if (group === undefined || isGroupAlive(group)) return;
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
      for (const group of instanceGroups) {
        killGroup(group);
        groupsBySession.get(sessionDirectory)?.delete(group);
      }
      instanceGroups.clear();
    },
  };
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

/** Exit code recorded for a job eve killed, or found gone without one. */
const KILLED_JOB_EXIT_CODE = "137";

/**
 * Kills the process group of every `bash` tool job under `jobRoot` that has
 * not written its exit code, optionally only jobs launched by `launchers`. The
 * launcher records its own pid, which is the pid of the command that ran it.
 *
 * Session directories outlive the eve process, and a group id is reused once
 * its processes are gone, so a job's pid is trusted only while it can still
 * name that job: written since this boot, and the group still exists. Once
 * killed or found gone, the job gets an `exit` file, so no later stop signals
 * whatever reuses the id.
 */
function killJobGroups(jobRoot: string, launchers?: ReadonlySet<number>): void {
  let jobs: string[];
  try {
    jobs = readdirSync(jobRoot);
  } catch {
    return;
  }
  const bootTime = Date.now() - uptime() * 1000;
  for (const job of jobs) {
    const directory = join(jobRoot, job);
    const pidPath = join(directory, "pid");
    const writtenAt = statSync(pidPath, { throwIfNoEntry: false })?.mtimeMs;
    const group = readPid(pidPath);
    if (writtenAt === undefined || group === undefined) continue;
    if (launchers !== undefined && !launchers.has(readPid(join(directory, "launcher")) ?? -1)) {
      continue;
    }
    if (!recordKilledJob(directory)) continue;
    if (writtenAt >= bootTime && isGroupAlive(group)) killGroup(group);
  }
}

/** Claims a job that has not exited by writing its exit code; false if it already had one. */
function recordKilledJob(directory: string): boolean {
  try {
    writeFileSync(join(directory, "exit"), KILLED_JOB_EXIT_CODE, { flag: "wx" });
    return true;
  } catch {
    return false;
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
