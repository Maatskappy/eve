import assert from "node:assert/strict";
import test from "node:test";

import {
  gitReadCommand,
  gitReadResult,
  MAX_GIT_OUTPUT_BYTES,
} from "../../extension/lib/git-read.ts";

test("subcommands outside the read-only set are refused", () => {
  for (const args of [
    ["commit", "-m", "x"],
    ["-c", "core.pager=sh", "log"],
    ["checkout", "main"],
    ["config", "core.fsmonitor", "sh"],
    [],
  ]) {
    assert.throws(() => gitReadCommand("/app", args), /is not available; use one of: blame, diff/u);
  }
});

test("--output is refused because it writes a file", () => {
  for (const args of [
    ["diff", "--output=/app/x"],
    ["log", "-p", "--output", "/app/x"],
  ]) {
    assert.throws(() => gitReadCommand("/app", args), /writes a file/u);
  }
});

test("git's exit code is split back out of stderr", () => {
  assert.deepEqual(
    gitReadResult({ stdout: "", stderr: "fatal: bad revision 'nope'\neve-git-exit:128\n" }),
    { exitCode: 128, stdout: "", stderr: "fatal: bad revision 'nope'\n", truncated: false },
  );
});

test("stdout past the cap is cut to the cap and marked truncated", () => {
  const result = gitReadResult({
    stdout: "x".repeat(MAX_GIT_OUTPUT_BYTES + 1),
    stderr: "eve-git-exit:141\n",
  });
  assert.equal(result.stdout.length, MAX_GIT_OUTPUT_BYTES);
  assert.equal(result.truncated, true);
});
