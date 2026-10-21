import { sandboxWorkspaceRoot, type SandboxSession } from "#shared/sandbox-session.js";

const MODEL_HOME_ROOT = "$HOME";

export const MODEL_SKILL_ROOT = `${MODEL_HOME_ROOT}/.agents/skills`;

/**
 * A provider whose home directory is not its own, such as the host sandbox,
 * sets this on every command so eve keeps skills in a directory it owns.
 */
export const SANDBOX_SKILL_ROOT_ENV = "EVE_SANDBOX_SKILL_ROOT";

// One probe reports the home directory and the declared skill root, one per line.
const SANDBOX_PATHS_PROBE_COMMAND = `printf '%s\\n%s\\n' "$HOME" "\${${SANDBOX_SKILL_ROOT_ENV}-}"`;

interface SandboxPaths {
  readonly home: string | null;
  readonly skillRoot: string | null;
}

const sandboxPathsCache = new WeakMap<SandboxSession, Promise<SandboxPaths>>();

/**
 * Resolves where skills live in the sandbox: the root the provider declares in
 * `EVE_SANDBOX_SKILL_ROOT`, else under the probed home, else under `skills/`
 * in the workspace root.
 */
export async function resolveSandboxSkillRoot(input: {
  readonly sandbox: SandboxSession;
}): Promise<string> {
  return await resolveSandboxModelPath({ path: MODEL_SKILL_ROOT, sandbox: input.sandbox });
}

/**
 * Resolves a leading `$HOME` in a model-supplied sandbox path without
 * evaluating any other shell syntax. `$HOME/.agents/skills` paths resolve to
 * the provider's declared skill root when it has one; other `$HOME` paths
 * always resolve to the sandbox's home. Skill paths fall back to `skills/`
 * under the workspace root when the sandbox has neither.
 */
export async function resolveSandboxModelPath(input: {
  readonly path: string;
  readonly sandbox: SandboxSession;
}): Promise<string> {
  if (!isModelHomePath(input.path)) {
    return input.path;
  }

  const { home, skillRoot } = await resolveSandboxPaths(input.sandbox);
  const skillSuffix = isModelSkillPath(input.path)
    ? input.path.slice(MODEL_SKILL_ROOT.length)
    : undefined;
  if (skillSuffix !== undefined && skillRoot !== null) {
    return `${skillRoot}${skillSuffix}`;
  }

  if (home !== null) {
    const suffix = input.path.slice(MODEL_HOME_ROOT.length);
    return suffix.length === 0 ? home : `${home === "/" ? "" : home}${suffix}`;
  }

  if (skillSuffix !== undefined) {
    return `${sandboxWorkspaceRoot(input.sandbox)}/skills${skillSuffix}`;
  }

  return input.path;
}

export async function resolveSandboxSkillWritePath(input: {
  readonly name: string;
  readonly relativePath: string;
  readonly sandbox: SandboxSession;
}): Promise<string> {
  return formatSkillPath({
    name: input.name,
    relativePath: input.relativePath,
    root: await resolveSandboxSkillRoot({ sandbox: input.sandbox }),
  });
}

function formatSkillPath(input: {
  readonly name: string;
  readonly relativePath: string;
  readonly root: string;
}): string {
  return `${input.root}/${input.name}/${input.relativePath}`;
}

async function resolveSandboxPaths(sandbox: SandboxSession): Promise<SandboxPaths> {
  const cached = sandboxPathsCache.get(sandbox);
  if (cached !== undefined) {
    return await cached;
  }

  const next = probeSandboxPaths(sandbox);
  sandboxPathsCache.set(sandbox, next);
  return await next;
}

async function probeSandboxPaths(sandbox: SandboxSession): Promise<SandboxPaths> {
  try {
    const result = await sandbox.run({ command: SANDBOX_PATHS_PROBE_COMMAND });
    if (result.exitCode !== 0) {
      return { home: null, skillRoot: null };
    }
    // A login profile can print before the probe, so read its two lines from the end.
    const lines = result.stdout.split("\n");
    const [home = "", skillRoot = ""] = lines.slice(-3, -1);
    return { home: usableDirectory(home), skillRoot: usableDirectory(skillRoot) };
  } catch {
    return { home: null, skillRoot: null };
  }
}

function isModelHomePath(path: string): boolean {
  return path === MODEL_HOME_ROOT || path.startsWith(`${MODEL_HOME_ROOT}/`);
}

function isModelSkillPath(path: string): boolean {
  return path === MODEL_SKILL_ROOT || path.startsWith(`${MODEL_SKILL_ROOT}/`);
}

function usableDirectory(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("/") || trimmed.includes("\0")) {
    return null;
  }
  return trimmed === "/" ? trimmed : trimmed.replace(/\/+$/, "");
}
