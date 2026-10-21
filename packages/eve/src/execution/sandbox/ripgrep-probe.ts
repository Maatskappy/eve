import type { SandboxSession } from "#public/definitions/sandbox.js";

const RIPGREP_PROBE_COMMAND = "rg --version";

const ripgrepAvailability = new WeakMap<SandboxSession, Promise<boolean>>();

/** Whether the sandbox has `rg`; glob and grep fall back to POSIX find and grep otherwise. */
export async function ripgrepIsAvailable(session: SandboxSession): Promise<boolean> {
  let available = ripgrepAvailability.get(session);
  if (available === undefined) {
    available = probeRipgrep(session);
    ripgrepAvailability.set(session, available);
  }
  return await available;
}

async function probeRipgrep(session: SandboxSession): Promise<boolean> {
  try {
    return (await session.run({ command: RIPGREP_PROBE_COMMAND })).exitCode === 0;
  } catch {
    return false;
  }
}
