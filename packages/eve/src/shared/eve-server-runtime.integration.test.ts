import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findNodeExecutable } from "./eve-server-runtime.js";

const NODE = process.platform === "win32" ? "node.exe" : "node";

let root: string;
let bunExecutable: string;

async function executable(path: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "", { mode: 0o755 });
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "eve-node-lookup-"));
  bunExecutable = await executable(join(root, "bun", "bin", "bun"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("findNodeExecutable", () => {
  it("skips a node shim hard-linked to Bun, as bun --bun creates on Windows", async () => {
    await mkdir(join(root, "shim"));
    await link(bunExecutable, join(root, "shim", NODE));
    const node = await executable(join(root, "node", "bin", NODE));

    expect(
      findNodeExecutable({
        bunExecutable,
        pathEnv: [join(root, "shim"), join(root, "node", "bin")].join(delimiter),
      }),
    ).toBe(node);
  });

  it.skipIf(process.platform === "win32")(
    "skips a node shim symlinked to Bun and keeps a version-manager shim's own path",
    async () => {
      await mkdir(join(root, "shim"));
      await symlink(bunExecutable, join(root, "shim", NODE));
      const versionManager = await executable(join(root, "volta", "volta-shim"));
      await mkdir(join(root, "volta", "bin"));
      await symlink(versionManager, join(root, "volta", "bin", NODE));

      expect(
        findNodeExecutable({
          bunExecutable,
          pathEnv: [join(root, "shim"), join(root, "volta", "bin")].join(delimiter),
        }),
      ).toBe(join(root, "volta", "bin", NODE));
    },
  );

  it("finds nothing when the only node on PATH is Bun", async () => {
    await mkdir(join(root, "shim"));
    await link(bunExecutable, join(root, "shim", NODE));

    expect(findNodeExecutable({ bunExecutable, pathEnv: join(root, "shim") })).toBeUndefined();
  });
});
