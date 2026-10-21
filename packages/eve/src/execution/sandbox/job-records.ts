import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The record the `bash` tool's launcher keeps for each command, one directory
 * per command under the job root: the launcher's pid, the command's process
 * group, its output, and finally its exit code. A provider that stops a
 * session's commands reads these records; it only supplies the signalling.
 */

/** Set by a provider that keeps per-session jobs, so it can find and stop them. */
export const JOB_ROOT_ENV = "EVE_SANDBOX_JOB_ROOT";

/** Where jobs live when the provider sets no job root. */
export const DEFAULT_JOB_ROOT = "/tmp/.eve/jobs";

/** The files in one job's directory. */
export const JOB_FILE = {
  /** Created by whichever of the launcher and the yield reports the command first. */
  claimed: "claimed",
  /** The command's exit code, written when it finishes or when a stop claims it. */
  exit: "exit",
  /** The launcher's pid, which is the pid of the command that ran it. */
  launcher: "launcher",
  /** The command's process group id. */
  pid: "pid",
  stderr: "stderr",
  stdout: "stdout",
} as const;

/** Exit code recorded for a job that was killed, or found gone without one. */
export const KILLED_JOB_EXIT_CODE = 137;

/** One job as a provider sees it when stopping a session. */
export interface JobRecord {
  readonly directory: string;
  /** True once the command recorded its exit code, or a stop claimed it. */
  readonly exited: boolean;
  /** The command's process group id. */
  readonly group: number;
  /** The pid of the command that launched it. */
  readonly launcher: number | undefined;
  /** When the launcher recorded the group, in epoch milliseconds. */
  readonly recordedAt: number;
}

/** Every job under `jobRoot` that recorded its process group. */
export function readJobRecords(jobRoot: string): JobRecord[] {
  let names: string[];
  try {
    names = readdirSync(jobRoot);
  } catch {
    return [];
  }
  const records: JobRecord[] = [];
  for (const name of names) {
    const directory = join(jobRoot, name);
    const recordedAt = statSync(join(directory, JOB_FILE.pid), { throwIfNoEntry: false })?.mtimeMs;
    const group = readPid(join(directory, JOB_FILE.pid));
    if (recordedAt === undefined || group === undefined) continue;
    records.push({
      directory,
      exited: statSync(join(directory, JOB_FILE.exit), { throwIfNoEntry: false }) !== undefined,
      group,
      launcher: readPid(join(directory, JOB_FILE.launcher)),
      recordedAt,
    });
  }
  return records;
}

/**
 * Claims a job that has not exited by recording it as killed. Returns false
 * when the job already has an exit code, so a stop never overwrites a real one
 * and never claims the same job twice.
 */
export function claimKilledJob(job: JobRecord): boolean {
  try {
    writeFileSync(join(job.directory, JOB_FILE.exit), String(KILLED_JOB_EXIT_CODE), {
      flag: "wx",
    });
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
