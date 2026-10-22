import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export function createSandboxProfiler({ fetch = globalThis.fetch, signal } = {}) {
  const context = new AsyncLocalStorage();
  const phases = [];
  const requests = [];
  const sandboxes = new Map();
  const origin = performance.now();

  return {
    phases,
    requests,
    sandboxes,
    async measure(scope, phase, run) {
      const started = performance.now();
      const entry = { ...scope, phase, startMs: started - origin, outcome: "failure" };
      try {
        const result = await context.run({ ...scope, phase }, run);
        entry.outcome = "success";
        return result;
      } finally {
        entry.durationMs = performance.now() - started;
        phases.push(entry);
      }
    },
    async fetch(input, init) {
      const scope = context.getStore() ?? { variant: "setup", phase: "prepare" };
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      let name;
      if (method === "POST" && /\/v[234]\/sandboxes$/u.test(url.pathname)) {
        name = JSON.parse(init.body).name;
        if (name) sandboxes.set(name, scope);
      }
      const signals = [AbortSignal.timeout(90_000)];
      if (init?.signal) signals.push(init.signal);
      else if (input instanceof Request) signals.push(input.signal);
      if (signal && scope.phase !== "cleanup") signals.push(signal);
      const started = performance.now();
      const entry = {
        ...scope,
        method,
        path: url.pathname,
        startedAt: new Date(performance.timeOrigin + started).toISOString(),
        startMs: started - origin,
        status: null,
        requestId: null,
        outcome: "failure",
      };
      try {
        const response = await fetch(input, { ...init, signal: AbortSignal.any(signals) });
        entry.status = response.status;
        entry.requestId = response.headers.get("x-vercel-id");
        entry.outcome = "success";
        // A conflicting name is not a resource this run owns.
        if (name && response.status === 409) sandboxes.delete(name);
        return response;
      } finally {
        entry.headersMs = performance.now() - started;
        requests.push(entry);
      }
    },
  };
}

export async function profileSandboxSession({ profiler, scope, open, cleanup }) {
  try {
    const sandbox = await profiler.measure(scope, "acquire-to-first-command", async () => {
      const opened = await profiler.measure(scope, "acquire", open);
      await profiler.measure(scope, "first-command", async () => {
        const result = await opened.run({ command: "printf eve-profile-ready" });
        if (result.exitCode !== 0 || result.stdout !== "eve-profile-ready") {
          throw new Error("Sandbox readiness command failed.");
        }
      });
      return opened;
    });
    await profiler.measure(scope, "command", async () => {
      const result = await sandbox.run({ command: "true" });
      if (result.exitCode !== 0) throw new Error("Sandbox command failed.");
    });
    await profiler.measure(scope, "write-file", () =>
      sandbox.writeTextFile({ path: "/workspace/.eve-profile", content: "eve-profile-file" }),
    );
    await profiler.measure(scope, "read-file", async () => {
      const content = await sandbox.readTextFile({ path: "/workspace/.eve-profile" });
      if (content !== "eve-profile-file") throw new Error("Sandbox file round trip failed.");
    });
  } finally {
    await profiler.measure(scope, "cleanup", cleanup);
  }
}

export function summarizeSandboxProfile(phases) {
  const groups = new Map();
  for (const entry of phases) {
    if (entry.warmup || entry.variant === "setup" || entry.phase === "cleanup") continue;
    const key = `${entry.variant}/${entry.phase}`;
    const group = groups.get(key) ?? { variant: entry.variant, phase: entry.phase, samples: [] };
    group.samples.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ variant, phase, samples }) => {
    const durations = samples
      .filter((sample) => sample.outcome === "success")
      .map((sample) => sample.durationMs)
      .sort((a, b) => a - b);
    const percentile = (p) => durations[Math.max(0, Math.ceil(durations.length * p) - 1)] ?? null;
    return {
      variant,
      phase,
      successes: durations.length,
      failures: samples.length - durations.length,
      minMs: durations[0] ?? null,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
    };
  });
}

export function sandboxProfileTrace({ phases, requests }) {
  const lanes = new Map();
  return {
    traceEvents: [...phases, ...requests].map((entry) => {
      const lane = `${entry.variant}/${entry.warmup ? "warmup" : "sample"}/${entry.sample ?? 0}`;
      if (!lanes.has(lane)) lanes.set(lane, lanes.size + 1);
      return {
        name: entry.method ? `HTTP ${entry.method} ${entry.path}` : entry.phase,
        cat: entry.method ? "http.headers" : "phase",
        ph: "X",
        ts: entry.startMs * 1_000,
        dur: (entry.durationMs ?? entry.headersMs) * 1_000,
        pid: 1,
        tid: lanes.get(lane),
        args: entry.method
          ? {
              status: entry.status,
              requestId: entry.requestId,
              phase: entry.phase,
              outcome: entry.outcome,
              lane,
            }
          : { outcome: entry.outcome, lane },
      };
    }),
  };
}
