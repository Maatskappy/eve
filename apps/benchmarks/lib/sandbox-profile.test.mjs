import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSandboxProfiler,
  profileSandboxSession,
  sandboxProfileTrace,
  summarizeSandboxProfile,
} from "./sandbox-profile.mjs";

test("HTTP artifacts retain correlation IDs without URLs, headers, bodies, or error messages", async () => {
  const profiler = createSandboxProfiler({
    async fetch() {
      return new Response("private response body", {
        headers: { "x-vercel-id": "iad1::request-123" },
      });
    },
  });
  await profiler.measure({ variant: "eve", sample: 1 }, "acquire", () =>
    profiler.fetch("https://api.vercel.com/v3/sandboxes?token=private-query", {
      method: "POST",
      headers: { authorization: "Bearer private-token" },
      body: JSON.stringify({ name: "eve-profile-owned", env: { PASSWORD: "private-env" } }),
    }),
  );
  const [request] = profiler.requests;
  assert.equal(request.path, "/v3/sandboxes");
  assert.equal(request.requestId, "iad1::request-123");
  assert.equal(request.phase, "acquire");
  assert.equal(request.status, 200);
  assert.ok(request.headersMs >= 0);
  const artifact = JSON.stringify({
    requests: profiler.requests,
    trace: sandboxProfileTrace(profiler),
  });
  assert.doesNotMatch(artifact, /private-|authorization|PASSWORD/u);
  assert.ok(profiler.sandboxes.has("eve-profile-owned"));
});

test("lost create responses remain eligible for cleanup, but conflicting names do not", async () => {
  for (const conflict of [false, true]) {
    const profiler = createSandboxProfiler({
      async fetch() {
        if (conflict) return new Response(null, { status: 409 });
        throw new Error("private transport diagnostics");
      },
    });
    const request = profiler.fetch("https://api.vercel.com/v3/sandboxes", {
      method: "POST",
      body: JSON.stringify({ name: "eve-profile-owned" }),
    });
    if (conflict) await request;
    else await assert.rejects(request, /private transport/u);
    assert.equal(profiler.sandboxes.has("eve-profile-owned"), !conflict);
    assert.equal(profiler.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(profiler.requests), /private transport/u);
  }
});

test("cleanup gets its own live signal after interruption", async () => {
  const abort = new AbortController();
  abort.abort();
  const signals = [];
  const profiler = createSandboxProfiler({
    signal: abort.signal,
    async fetch(_input, init) {
      signals.push(init.signal.aborted);
      return new Response(null, { status: 200 });
    },
  });
  const run = () => profiler.fetch("https://api.vercel.com/v2/sandboxes/eve-profile-owned");
  await profiler.measure({ variant: "eve" }, "acquire", run);
  await profiler.measure({ variant: "eve" }, "cleanup", run);
  assert.deepEqual(signals, [true, false]);
});

test("session failures still clean up and do not record later operations as successful", async () => {
  for (const failure of ["acquire", "first-command", "read-file", null]) {
    const profiler = createSandboxProfiler();
    let cleaned = 0;
    const run = profileSandboxSession({
      profiler,
      scope: { variant: "eve", sample: 1, warmup: false },
      async open() {
        if (failure === "acquire") throw new Error("acquisition failed");
        return {
          async run({ command }) {
            return {
              exitCode: failure === "first-command" ? 1 : 0,
              stdout: command === "true" ? "" : "eve-profile-ready",
            };
          },
          async writeTextFile() {},
          async readTextFile() {
            return failure === "read-file" ? "wrong file" : "eve-profile-file";
          },
        };
      },
      async cleanup() {
        cleaned++;
      },
    });
    if (failure) await assert.rejects(run);
    else await run;
    assert.equal(cleaned, 1);
    const summary = summarizeSandboxProfile(profiler.phases);
    if (failure) {
      assert.equal(summary.find((row) => row.phase === failure).failures, 1);
      if (failure === "acquire" || failure === "first-command") {
        assert.equal(
          summary.some((row) => row.phase === "write-file"),
          false,
        );
      }
    } else {
      assert.ok(summary.every((row) => row.failures === 0));
      assert.equal(summary.find((row) => row.phase === "read-file").successes, 1);
    }
  }
});

test("latency summaries exclude warmups and failures without hiding failure counts", () => {
  const sample = { variant: "eve", phase: "acquire", outcome: "success", warmup: false };
  const summary = summarizeSandboxProfile([
    ...[10, 20, 30, 40].map((durationMs) => ({ ...sample, durationMs })),
    { ...sample, durationMs: 1_000, warmup: true },
    { ...sample, durationMs: 2_000, outcome: "failure" },
    { ...sample, durationMs: 3_000, phase: "cleanup" },
    { ...sample, durationMs: 4_000, variant: "setup" },
  ]);
  assert.deepEqual(summary, [
    {
      variant: "eve",
      phase: "acquire",
      successes: 4,
      failures: 1,
      minMs: 10,
      p50Ms: 20,
      p95Ms: 40,
      p99Ms: 40,
    },
  ]);
});
