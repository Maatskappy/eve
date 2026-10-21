import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
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

/** Live process groups by session directory, so session-end cleanup reaches every handle's. */
const liveProcessesBySession = new Map<string, Set<ChildProcess>>();

/**
 * Opens a host session: real `bash` and filesystem, rooted at `workspaceRoot`.
 * Every command runs in its own process group so abort and stop can kill
 * whatever it started.
 */
export async function openHostSandboxHandle(input: {
  readonly appRoot: string;
  /** Session-owned directory; deleting the sandbox removes it. */
  readonly sessionDirectory: string;
  readonly skillRoot: string;
  readonly workspaceRoot: string;
}): Promise<SandboxProviderHandle<SandboxSession>> {
  const environmentRoot = (await findEveProjectRoot(input.appRoot)) ?? input.appRoot;
  const processes = new Set<ChildProcess>();
  const resolvePath = (path: string) =>
    isAbsolute(path) ? path : resolve(input.workspaceRoot, path);

  const sandbox = buildSandboxSession({
    resolvePath,
    skillRoot: input.skillRoot,
    async spawn(options) {
      options.abortSignal?.throwIfAborted();
      const child = spawn("bash", ["-c", options.command], {
        cwd: resolvePath(options.workingDirectory ?? "."),
        detached: true,
        env: { ...hostEnvironment(environmentRoot), ...SANDBOX_AGENT_ENV, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return trackProcess(child, options, [processes, sessionProcesses(input.sessionDirectory)]);
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

  return {
    sandbox,
    async onRuntimeShutdown() {
      killProcesses(processes);
    },
    async onSandboxDelete() {
      await removeHostSessionDirectory(input.sessionDirectory);
    },
    async onSandboxStop() {
      killProcesses(processes);
    },
  };
}

/** Kills every live command of the session, then removes its eve-owned directory. */
export async function removeHostSessionDirectory(sessionDirectory: string): Promise<void> {
  killProcesses(sessionProcesses(sessionDirectory));
  liveProcessesBySession.delete(sessionDirectory);
  await rm(sessionDirectory, { force: true, recursive: true });
}

/**
 * The environment eve was launched with, minus the values it loaded from
 * development env files. Re-reading the files at spawn keeps this right across
 * env-file reloads and the dev server's process boundary; a key whose value
 * differs from the file came from the shell and stays.
 */
function hostEnvironment(environmentRoot: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const [key, value] of readDevelopmentEnvironmentValues(environmentRoot)) {
    if (environment[key] === value) delete environment[key];
  }
  return environment;
}

function trackProcess(
  child: ChildProcess,
  options: SandboxSpawnOptions,
  registries: readonly Set<ChildProcess>[],
): SandboxProcess {
  for (const registry of registries) registry.add(child);
  let closed = false;
  // Once the pipes close the group is gone, and its id may belong to another group.
  const kill = () => {
    if (!closed) killProcessGroup(child);
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
    for (const registry of registries) registry.delete(child);
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

function sessionProcesses(sessionDirectory: string): Set<ChildProcess> {
  let processes = liveProcessesBySession.get(sessionDirectory);
  if (processes === undefined) {
    processes = new Set();
    liveProcessesBySession.set(sessionDirectory, processes);
  }
  return processes;
}

function killProcesses(processes: ReadonlySet<ChildProcess>): void {
  for (const child of processes) killProcessGroup(child);
}

function killProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    // The negative pid targets the detached command's whole process group,
    // which can outlive `bash` itself until its last member closes the pipes.
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
