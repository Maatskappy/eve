import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  gitReadCommand,
  gitReadResult,
  MAX_GIT_OUTPUT_BYTES,
} from "../../extension/lib/git-read.ts";

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "eve-code-git-read-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "alice@example.com");
  git("config", "user.name", "Alice");
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
  git("add", "a.ts");
  git("commit", "-qm", "add a");
  return { root, git };
}

function run(root: string, args: string[]) {
  const result = spawnSync("sh", ["-c", gitReadCommand(root, args)], { encoding: "utf8" });
  return gitReadResult({ stdout: result.stdout, stderr: result.stderr });
}

test("a reviewer sees the staged change without touching the index", async () => {
  const { root, git } = await repository();
  try {
    await writeFile(join(root, "a.ts"), "export const a = 2;\n");
    git("add", "a.ts");
    const index = join(root, ".git", "index");
    const before = { bytes: await readFile(index), mtime: (await stat(index)).mtimeMs };

    const diff = run(root, ["diff", "--cached"]);
    assert.equal(diff.exitCode, 0);
    assert.match(diff.stdout, /^\+export const a = 2;$/mu);
    assert.equal(run(root, ["status", "--short"]).stdout, "M  a.ts\n");

    assert.deepEqual(await readFile(index), before.bytes);
    assert.equal((await stat(index)).mtimeMs, before.mtime);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git's failure exit code and message come back", async () => {
  const { root } = await repository();
  try {
    const result = run(root, ["show", "no-such-revision"]);
    assert.equal(result.exitCode, 128);
    assert.match(result.stderr, /no-such-revision/u);
    assert.doesNotMatch(result.stderr, /eve-git-exit/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("output larger than the cap stops at the cap", async () => {
  const { root, git } = await repository();
  try {
    await writeFile(join(root, "big.txt"), "line\n".repeat(MAX_GIT_OUTPUT_BYTES));
    git("add", "big.txt");
    const result = run(root, ["diff", "--cached"]);
    assert.equal(result.truncated, true);
    assert.equal(Buffer.byteLength(result.stdout), MAX_GIT_OUTPUT_BYTES);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
