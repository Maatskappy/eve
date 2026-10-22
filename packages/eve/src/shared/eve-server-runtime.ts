import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import { resolvePackageRoot } from "#internal/application/package.js";

/**
 * Executable for the eve dev server a framework integration spawns. It
 * inherits the framework's runtime, except under Bun: eve's dev worker cannot
 * run on Bun, so `bun --bun next dev` hands the server off to Node.js on PATH.
 */
export function resolveEveDevServerCommand(hostLabel: string): string {
  if (process.versions.bun === undefined) return process.execPath;

  const node = findNodeExecutable({ bunExecutable: process.execPath, pathEnv: process.env.PATH });
  if (node === undefined) {
    throw new Error(
      [
        `eve's development server needs Node.js ${readNodeEngineRange()}, but no \`node\` executable was found on PATH.`,
        `${hostLabel} is running under Bun, which cannot host eve's development server.`,
        `Install Node.js, or start ${hostLabel} without \`bun --bun\`.`,
      ].join(" "),
    );
  }
  return node;
}

/**
 * First `node` on `pathEnv` that is not Bun itself. `bun --bun` prepends a
 * `node` shim that links to Bun (a symlink, or a hard link on Windows), so
 * candidates are compared by file identity rather than path. Returns the PATH
 * entry, not its target, so version-manager shims keep dispatching on their name.
 */
export function findNodeExecutable(input: {
  readonly bunExecutable: string;
  readonly pathEnv: string | undefined;
}): string | undefined {
  const bun = fileIdentity(input.bunExecutable);
  const name = process.platform === "win32" ? "node.exe" : "node";
  for (const directory of (input.pathEnv ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      const stats = statSync(candidate, { bigint: true });
      if (stats.isFile() && `${stats.dev}:${stats.ino}` !== bun) return candidate;
    } catch {
      // Not on this PATH entry.
    }
  }
  return undefined;
}

/** Explains why `eve dev` refuses to start under Bun and how to run it instead. */
export function createBunDevServerError(): Error {
  return new Error(
    [
      `eve dev needs Node.js ${readNodeEngineRange()} and cannot run under Bun.`,
      "Start it without `--bun`; `bun run dev` with an `eve dev` script runs eve on Node.js.",
    ].join(" "),
  );
}

// Bigint keeps Windows' 64-bit file index exact.
function fileIdentity(path: string): string {
  const { dev, ino } = statSync(path, { bigint: true });
  return `${dev}:${ino}`;
}

function readNodeEngineRange(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(resolvePackageRoot(), "package.json"), "utf8"),
    ) as { engines?: { node?: unknown } };
    if (typeof manifest.engines?.node === "string") return manifest.engines.node;
  } catch {
    // Fall through to the generic wording; the error itself must still surface.
  }
  return "(see eve's engines.node)";
}
