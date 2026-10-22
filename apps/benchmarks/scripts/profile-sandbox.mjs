#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  createSandboxProfiler,
  profileSandboxSession,
  sandboxProfileTrace,
  summarizeSandboxProfile,
} from "../lib/sandbox-profile.mjs";

const { values } = parseArgs({
  options: {
    team: { type: "string" },
    project: { type: "string" },
    samples: { type: "string", default: "10" },
    warmup: { type: "string", default: "2" },
    cpus: { type: "string", default: "2" },
    region: { type: "string", default: "iad1" },
    variant: { type: "string", default: "both" },
    snapshot: { type: "string" },
    "eve-dir": { type: "string" },
    out: { type: "string" },
    dry: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`Usage: pnpm profile:sandbox --team <team_id> --project <prj_id> [options]

Creates disposable, billable sandboxes. Requires VERCEL_TOKEN or VERCEL_OIDC_TOKEN.

  --samples <1..100>        Measured samples per variant (default 10)
  --warmup <0..10>          Excluded warmup samples per variant (default 2)
  --variant <eve|sdk|both>  Actual eve provider versus direct SDK creation (default both)
  --cpus <1..32>           vCPUs for every sandbox (default 2)
  --region <region>        Sandbox region (default iad1; does not move the client)
  --snapshot <snap_id>     Use an existing prepared snapshot; never delete it
  --eve-dir <path>         Built packages/eve directory to profile
  --out <directory>        New artifact directory (must not exist)
  --dry                    Validate options and print the plan without API calls

Run pnpm --filter eve build:js first. Output: profile.json, trace.json, summary.md.
HTTP spans end at response headers; operation phases include SDK/body/command waits.`);
  process.exit(0);
}

function integer(name, min, max) {
  const value = Number(values[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

if (!values.team?.startsWith("team_") || !values.project?.startsWith("prj_")) {
  throw new Error("Pass explicit --team team_... and --project prj_... targets.");
}
if (!["eve", "sdk", "both"].includes(values.variant)) {
  throw new Error("--variant must be eve, sdk, or both.");
}
const samples = integer("samples", 1, 100);
const warmup = integer("warmup", 0, 10);
const cpus = integer("cpus", 1, 32);
if (values.dry) {
  console.log(
    JSON.stringify(
      {
        teamId: values.team,
        projectId: values.project,
        samples,
        warmup,
        cpus,
        region: values.region,
        variant: values.variant,
        snapshotId: values.snapshot ?? null,
        plannedSandboxCreates:
          (samples + warmup) * (values.variant === "both" ? 2 : 1) + (values.snapshot ? 0 : 2),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const token = process.env.VERCEL_TOKEN || process.env.VERCEL_OIDC_TOKEN;
if (!token) throw new Error("Set VERCEL_TOKEN or VERCEL_OIDC_TOKEN before profiling.");

const eveRoot = values["eve-dir"]
  ? resolve(values["eve-dir"])
  : fileURLToPath(new URL("../../../packages/eve/", import.meta.url));
const bindings = resolve(eveRoot, "dist/src/execution/sandbox/bindings");
try {
  await access(resolve(bindings, "vercel.js"));
} catch {
  throw new Error(`Build ${eveRoot} with pnpm --filter eve build:js before profiling.`);
}
const load = (path) => import(pathToFileURL(resolve(eveRoot, path)).href);
const [
  { createVercelSandboxProvider },
  { createSandboxProviderHost },
  { createSandboxProviderFiles },
  sdk,
  packageInfo,
] = await Promise.all([
  load("dist/src/execution/sandbox/bindings/vercel.js"),
  load("dist/src/execution/sandbox/provider-host.js"),
  load("dist/src/execution/sandbox/provider-files.js"),
  load("dist/src/compiled/@vercel/sandbox/index.js"),
  readFile(resolve(eveRoot, "package.json"), "utf8").then(JSON.parse),
]);
const runId = randomUUID();
const directory = values.out
  ? resolve(values.out)
  : fileURLToPath(new URL(`../results/sandbox-profile/${Date.now()}-${runId}/`, import.meta.url));
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory);
const abort = new AbortController();
const interrupt = () => abort.abort();
const deadline = setTimeout(interrupt, 30 * 60_000);
deadline.unref();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const profiler = createSandboxProfiler({ signal: abort.signal });
const credentials = {
  token,
  teamId: values.team,
  projectId: values.project,
  fetch: profiler.fetch,
};
const options = {
  ...credentials,
  region: values.region,
  resources: { vcpus: cpus },
  timeout: 300_000,
};
const provider = createVercelSandboxProvider(options);
const host = createSandboxProviderHost(eveRoot);
const metadata = {
  runId,
  startedAt: new Date().toISOString(),
  teamId: values.team,
  projectId: values.project,
  eveVersion: packageInfo.version,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: eveRoot, encoding: "utf8" }).trim(),
  dirty:
    execFileSync("git", ["status", "--porcelain"], { cwd: eveRoot, encoding: "utf8" }).length > 0,
  nodeVersion: process.version,
  clientPlatform: process.platform,
  clientRegion: process.env.VERCEL_REGION ?? null,
  sandboxRegion: values.region,
  cpus,
  samples,
  warmup,
  suppliedSnapshot: values.snapshot ?? null,
};
let artifact;
let failed = false;
let ownedSnapshot;

async function cleanup(scope) {
  let incomplete = false;
  for (const [name, owner] of profiler.sandboxes) {
    if (scope && (owner.variant !== scope.variant || owner.sample !== scope.sample)) continue;
    try {
      const sandbox = await sdk.Sandbox.get({ ...credentials, name, resume: false });
      if (sandbox.status === "running" || sandbox.status === "pending") await sandbox.stop();
      await sandbox.delete({ deleteOrphanSnapshots: true });
      profiler.sandboxes.delete(name);
    } catch (error) {
      if (error?.status === 404 || error?.response?.status === 404) profiler.sandboxes.delete(name);
      else incomplete = true;
    }
  }
  if (incomplete) throw new Error("Some profiling sandboxes could not be deleted.");
}

async function save() {
  const summary = summarizeSandboxProfile(profiler.phases);
  const report = {
    schemaVersion: 1,
    metadata,
    snapshotId: artifact?.snapshotId ?? null,
    failed,
    remainingSandboxes: [...profiler.sandboxes.keys()],
    remainingSnapshot: ownedSnapshot ?? null,
    phases: profiler.phases,
    requests: profiler.requests,
    summary,
  };
  const lines = [
    "# Sandbox profile",
    "",
    `eve ${metadata.eveVersion}, ${metadata.revision}${metadata.dirty ? " (dirty)" : ""}. Client: ${metadata.clientRegion ?? "local / unknown region"}; sandbox: ${metadata.sandboxRegion}; ${cpus} vCPUs.`,
    "",
    "SDK is a create-only lower-level baseline, not a replacement for eve's acquisition contract.",
    "Warmups, setup, cleanup, and failed phases are excluded from latency percentiles. Failures are counted separately.",
    "",
    "| Variant | Phase | Successful | Failed | Min ms | p50 ms | p95 ms | p99 ms |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summary.map(
      (row) =>
        `| ${row.variant} | ${row.phase} | ${row.successes} | ${row.failures} | ${[row.minMs, row.p50Ms, row.p95Ms, row.p99Ms].map((n) => n?.toFixed(1) ?? "—").join(" | ")} |`,
    ),
    "",
    "HTTP request IDs and UTC start times are in profile.json. trace.json uses Chrome/Perfetto trace-event format.",
    "HTTP durations measure time to response headers, not streamed body or command completion.",
  ];
  await Promise.all([
    writeFile(resolve(directory, "profile.json"), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    }),
    writeFile(
      resolve(directory, "trace.json"),
      `${JSON.stringify(sandboxProfileTrace(profiler))}\n`,
      { mode: 0o600 },
    ),
    writeFile(resolve(directory, "summary.md"), `${lines.join("\n")}\n`, { mode: 0o600 }),
  ]);
}

console.log(`Profiling ${values.team}/${values.project}; artifacts: ${directory}`);
try {
  artifact = values.snapshot
    ? { snapshotId: values.snapshot }
    : await profiler.measure({ variant: "setup" }, "prepare", () =>
        provider.prepare({
          host,
          files: createSandboxProviderFiles(resolve(eveRoot, "sandbox")),
          resources: { source: { kind: "none" } },
          sourceRevision: runId,
          storagePath: directory,
        }),
      );
  if (!values.snapshot) ownedSnapshot = artifact.snapshotId;
  await save();
  for (let index = 0; index < warmup + samples; index++) {
    const variants =
      values.variant === "both" ? (index % 2 ? ["sdk", "eve"] : ["eve", "sdk"]) : [values.variant];
    for (const variant of variants) {
      abort.signal.throwIfAborted();
      const scope = { variant, sample: index + 1, warmup: index < warmup };
      const session = {
        auth: { current: null, initiator: null },
        id: randomUUID(),
        turn: { id: "profile", sequence: 0 },
      };
      await profileSandboxSession({
        profiler,
        scope,
        async open() {
          if (variant === "eve") {
            return (await provider.start({ host, session, storagePath: directory }, {}, artifact))
              .handle.sandbox;
          }
          const sandbox = await sdk.Sandbox.create({
            ...options,
            name: `eve-profile-${session.id}`,
            persistent: true,
            source: { type: "snapshot", snapshotId: artifact.snapshotId },
          });
          return {
            async run({ command }) {
              const result = await sandbox.runCommand({ cmd: "bash", args: ["-lc", command] });
              return { exitCode: result.exitCode, stdout: await result.stdout() };
            },
            writeTextFile: ({ path, content }) =>
              sandbox.writeFiles([{ path, content: Buffer.from(content) }]),
            async readTextFile({ path }) {
              const stream = await sandbox.readFile({ path });
              if (stream === null) return null;
              const chunks = [];
              let bytes = 0;
              for await (const chunk of stream) {
                bytes += chunk.length;
                if (bytes > 1_024) throw new Error("Unexpected profiling file size.");
                chunks.push(Buffer.from(chunk));
              }
              return Buffer.concat(chunks).toString("utf8");
            },
          };
        },
        cleanup: () => cleanup(scope),
      });
      await save();
      console.log(`${variant}: ${scope.warmup ? "warmup" : "sample"} ${index + 1} complete`);
    }
  }
} catch {
  failed = true;
  console.error(
    "Profile failed or was interrupted. Inspect phase outcomes, HTTP statuses, and request IDs in profile.json; response bodies and exception messages are intentionally not logged.",
  );
} finally {
  await profiler
    .measure({ variant: "setup" }, "cleanup", async () => {
      let incomplete = false;
      try {
        await cleanup();
      } catch {
        incomplete = true;
      }
      if (ownedSnapshot) {
        try {
          const snapshot = await sdk.Snapshot.get({ ...credentials, snapshotId: ownedSnapshot });
          await snapshot.delete();
          ownedSnapshot = undefined;
        } catch (error) {
          if (error?.status === 404 || error?.response?.status === 404) ownedSnapshot = undefined;
          else incomplete = true;
        }
      }
      if (incomplete) throw new Error("Profiling resource cleanup is incomplete.");
    })
    .catch(() => {
      failed = true;
    });
  await save();
  clearTimeout(deadline);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  console.log(`Report: ${resolve(directory, "summary.md")}`);
  if (profiler.sandboxes.size || ownedSnapshot) {
    console.error("Cleanup incomplete: remaining resource names/IDs are listed in profile.json.");
  }
  process.exitCode = failed ? 1 : 0;
}
