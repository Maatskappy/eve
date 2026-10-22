import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import { resolvePackageRoot } from "#internal/application/package.js";

/** A `node` executable on PATH and the file it resolves to through symlinks. */
export interface NodeExecutableCandidate {
  readonly path: string;
  readonly target: string;
}

/**
 * Executable for the eve dev server a framework integration spawns. It
 * inherits the framework's runtime, except under Bun: eve's dev worker cannot
 * run on Bun, so `bun --bun next dev` hands the server off to Node.js on PATH.
 */
export function resolveEveDevServerCommand(hostLabel: string): string {
  if (process.versions.bun === undefined) return process.execPath;

  const node = selectNodeExecutable(findNodeExecutables(), realpathSync(process.execPath));
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
 * Picks the first `node` on PATH that is not Bun itself. `bun --bun` prepends
 * a `node` shim that links to Bun, so the bare command name would loop back.
 * Returns the PATH entry rather than its target so version-manager shims keep
 * dispatching on their own name.
 */
export function selectNodeExecutable(
  candidates: readonly NodeExecutableCandidate[],
  bunExecutable: string,
): string | undefined {
  return candidates.find((candidate) => candidate.target !== bunExecutable)?.path;
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

function findNodeExecutables(): NodeExecutableCandidate[] {
  const name = process.platform === "win32" ? "node.exe" : "node";
  const candidates: NodeExecutableCandidate[] = [];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const path = join(directory, name);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) candidates.push({ path, target: realpathSync(path) });
    } catch {
      // Not on this PATH entry.
    }
  }
  return candidates;
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
