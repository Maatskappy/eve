import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, realpath, utimes, writeFile } from "node:fs/promises";
import { homedir, uptime } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BASH_YIELD_SECONDS, executeBashOnSandbox } from "#execution/sandbox/bash.js";

import { releaseHostSandboxHandle } from "#execution/sandbox/bindings/host-session.js";
import { createHostSandboxProvider } from "#execution/sandbox/bindings/host.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";
import { createSandboxProviderHarness } from "#internal/testing/sandbox-provider-harness.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import type { HostSandboxEnvironmentOptions } from "#public/sandbox/host-sandbox.js";
import { sandboxWorkspaceRoot, type SandboxSession } from "#shared/sandbox-session.js";
import {
  removeSkillPackageFromSandbox,
  writeSkillPackageToSandbox,
} from "#shared/skill-package.js";
import { resolveSandboxModelPath, resolveSandboxSkillRoot } from "#shared/skill-paths.js";

const createScratchDirectory = useTemporaryDirectories();

function createHostProvider(options: HostSandboxEnvironmentOptions = {}) {
  const implementation = createHostSandboxProvider(options);
  return {
    ...createSandboxProviderHarness(implementation, undefined),
    async endSession(appRoot: string, sessionId: string) {
      await implementation.onSessionEnd?.(
        {
          host: createSandboxProviderHost(appRoot),
          session: {
            auth: { current: null, initiator: null },
            id: sessionId,
            turn: { id: "test-turn", sequence: 0 },
          },
          storagePath: appRoot,
        },
        { templateKey: "unused" },
        { root: "unused", version: 1 },
        { reason: "completed" },
      );
    },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts a `bash` tool job that outlives the call's yield; returns its background pid. */
async function startBashJob(
  sandbox: SandboxSession,
  pidFile: string,
): Promise<{ readonly job: number; readonly outputDirectory: string }> {
  const call = executeBashOnSandbox(sandbox, { command: `sleep 60 & echo $! > ${pidFile}; wait` });
  let job = 0;
  await vi.waitFor(async () => {
    job = Number((await readFile(sandbox.resolvePath(pidFile), "utf8")).trim());
    expect(job).toBeGreaterThan(0);
  });
  await vi.advanceTimersByTimeAsync(BASH_YIELD_SECONDS * 1000);
  const result = await call;
  if (result.status !== "running") throw new Error(`expected running: ${JSON.stringify(result)}`);
  expect(isProcessAlive(job)).toBe(true);
  return { job, outputDirectory: result.outputDirectory };
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.trim().length > 0) return text.trim();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

describe("HostSandbox", () => {
  it("runs real bash in a per-session workspace seeded from resources and prepare", async () => {
    const appRoot = await createScratchDirectory("eve-host-seeded-");
    const outside = await createScratchDirectory("eve-host-outside-");
    const provider = createHostProvider({
      async prepare(sandbox) {
        await sandbox.run({ command: "printf prepared > prepared.txt" });
      },
    });
    await provider.prepare({
      appRoot,
      seedFiles: [
        { content: "seeded", path: "/workspace/notes/seed.md" },
        { content: "# Weather", path: "$HOME/.agents/skills/weather/SKILL.md" },
      ],
    });

    const { sandbox } = await provider.openSession({ appRoot, sandboxName: "session-a" });
    const root = sandboxWorkspaceRoot(sandbox);

    expect(root.startsWith(join(appRoot, "host", "sessions"))).toBe(true);
    expect((await sandbox.run({ command: "pwd -P" })).stdout.trim()).toBe(await realpath(root));
    expect(await sandbox.readTextFile({ path: "notes/seed.md" })).toBe("seeded");
    expect(await sandbox.readTextFile({ path: "prepared.txt" })).toBe("prepared");

    const skillRoot = await resolveSandboxSkillRoot({ sandbox });
    expect(skillRoot.startsWith(join(appRoot, "host", "sessions"))).toBe(true);
    expect(skillRoot.startsWith(homedir())).toBe(false);
    expect(
      await sandbox.readTextFile({
        path: await resolveSandboxModelPath({
          path: "$HOME/.agents/skills/weather/SKILL.md",
          sandbox,
        }),
      }),
    ).toBe("# Weather");

    await sandbox.writeTextFile({ content: "absolute", path: join(outside, "out.txt") });
    expect(await readFile(join(outside, "out.txt"), "utf8")).toBe("absolute");
  });

  it("isolates sessions, reopens one by session id, and removes it when the session ends", async () => {
    const appRoot = await createScratchDirectory("eve-host-sessions-");
    const provider = createHostProvider();
    await provider.prepare({ appRoot });

    const first = await provider.start({ appRoot, sandboxName: "session-a" });
    const second = await provider.start({ appRoot, sandboxName: "session-b" });
    await first.handle.sandbox.writeTextFile({ content: "a", path: "owner.txt" });

    expect(second.state.root).not.toBe(first.state.root);
    expect(await second.handle.sandbox.readTextFile({ path: "owner.txt" })).toBeNull();

    const reopened = await provider.start({ appRoot, sandboxName: "session-a" });
    expect(reopened.state).toEqual(first.state);
    expect(await reopened.handle.sandbox.readTextFile({ path: "owner.txt" })).toBe("a");
    const resumed = await provider.openSession({
      appRoot,
      existing: first.state,
      sandboxName: "session-a",
    });
    expect(await resumed.sandbox.readTextFile({ path: "owner.txt" })).toBe("a");
    await expect(
      provider.openSession({ appRoot, existing: second.state, sandboxName: "session-a" }),
    ).rejects.toThrow("incompatible");

    await provider.endSession(appRoot, "session-a");
    expect(existsSync(first.state.root)).toBe(false);
    expect(existsSync(second.state.root)).toBe(true);
  });

  it("kills the whole process group when a command is aborted or the sandbox stops", async () => {
    const appRoot = await createScratchDirectory("eve-host-processes-");
    const provider = createHostProvider();
    const { sandbox, onSandboxStop } = await provider.openSession({
      appRoot,
      sandboxName: "session-processes",
    });

    const controller = new AbortController();
    const aborted = await sandbox.spawn({
      abortSignal: controller.signal,
      command: "sleep 30 & echo $! > aborted.pid; wait",
    });
    const abortedChild = Number(await waitForFile(sandbox.resolvePath("aborted.pid")));
    controller.abort(new Error("stop the build"));
    await expect(aborted.wait()).rejects.toThrow("stop the build");

    await sandbox.spawn({ command: "sleep 30 & echo $! > stopped.pid; wait" });
    const stoppedChild = Number(await waitForFile(sandbox.resolvePath("stopped.pid")));
    // The command returns at once, but its redirected background job keeps its group alive.
    const orphan = Number(
      (await sandbox.run({ command: "sleep 30 > /dev/null 2>&1 & echo $!" })).stdout,
    );
    expect(isProcessAlive(orphan)).toBe(true);
    await onSandboxStop();

    await expect.poll(() => isProcessAlive(abortedChild)).toBe(false);
    await expect.poll(() => isProcessAlive(stoppedChild)).toBe(false);
    await expect.poll(() => isProcessAlive(orphan)).toBe(false);
  });

  it("writes and removes skill packages in its own skill root, never under the real HOME", async () => {
    const home = await createScratchDirectory("eve-host-home-");
    vi.stubEnv("HOME", home);
    try {
      const appRoot = await createScratchDirectory("eve-host-skills-");
      const { sandbox } = await createHostProvider().openSession({
        appRoot,
        sandboxName: "session-skills",
      });
      // Hides anything attached under a symbol, like a wrapper that rebuilds the session.
      const wrapped: SandboxSession = new Proxy(sandbox, {
        get: (target, key) => (typeof key === "symbol" ? undefined : Reflect.get(target, key)),
      });
      const skill = {
        description: "Tenant notes",
        files: [{ content: Buffer.from("notes"), relativePath: "references/notes.md" }],
        markdown: "# Tenant",
        name: "tenant",
      };

      await writeSkillPackageToSandbox({ sandbox: wrapped, skill });
      const skillRoot = await resolveSandboxSkillRoot({ sandbox: wrapped });
      expect(skillRoot.startsWith(join(appRoot, "host", "sessions"))).toBe(true);
      await expect(readFile(join(skillRoot, "tenant/references/notes.md"), "utf8")).resolves.toBe(
        "notes",
      );
      await removeSkillPackageFromSandbox({ name: "tenant", sandbox: wrapped });

      expect(existsSync(join(skillRoot, "tenant"))).toBe(false);
      expect(existsSync(join(home, ".agents"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe("bash tool jobs", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("stops jobs that keep running after the call returns and records them as killed", async () => {
      const appRoot = await createScratchDirectory("eve-host-jobs-");
      const { sandbox, onSandboxStop } = await createHostProvider().openSession({
        appRoot,
        sandboxName: "session-jobs",
      });
      const { job, outputDirectory } = await startBashJob(sandbox, "job.pid");
      expect(outputDirectory.startsWith(join(appRoot, "host", "sessions"))).toBe(true);

      await onSandboxStop();

      await vi.waitFor(() => expect(isProcessAlive(job)).toBe(false), { timeout: 10_000 });
      await expect(readFile(join(outputDirectory, "exit"), "utf8")).resolves.toBe("137");
    });

    it("releasing one keyed handle stops only the jobs that handle started", async () => {
      const appRoot = await createScratchDirectory("eve-host-release-");
      const provider = createHostProvider();
      const released = await provider.openSession({ appRoot, sandboxName: "session-keyed" });
      const kept = await provider.openSession({ appRoot, sandboxName: "session-keyed" });
      const releasedJob = (await startBashJob(released.sandbox, "released.pid")).job;
      const keptJob = (await startBashJob(kept.sandbox, "kept.pid")).job;

      releaseHostSandboxHandle(released);

      await vi.waitFor(() => expect(isProcessAlive(releasedJob)).toBe(false), {
        timeout: 10_000,
      });
      expect(isProcessAlive(keptJob)).toBe(true);
      await kept.onSandboxStop();
      await vi.waitFor(() => expect(isProcessAlive(keptJob)).toBe(false), { timeout: 10_000 });
    });
  });

  it("never signals a job pid recorded before this boot", async () => {
    const appRoot = await createScratchDirectory("eve-host-stale-");
    const { sandbox, onSandboxStop } = await createHostProvider().openSession({
      appRoot,
      sandboxName: "session-stale",
    });
    // An unrelated process group that now holds the id a job recorded before a reboot.
    const unrelated = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      const jobRoot = (await sandbox.run({ command: 'printf %s "$EVE_SANDBOX_JOB_ROOT"' })).stdout;
      const stale = join(jobRoot, "stale");
      await mkdir(stale, { recursive: true });
      await writeFile(join(stale, "pid"), `${unrelated.pid}\n`);
      const beforeBoot = new Date(Date.now() - uptime() * 1000 - 3_600_000);
      await utimes(join(stale, "pid"), beforeBoot, beforeBoot);

      await onSandboxStop();

      // The test owns this child, so a kill would leave a zombie; read its exit status instead.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(unrelated.signalCode).toBeNull();
      await expect(readFile(join(stale, "exit"), "utf8")).resolves.toBe("137");
    } finally {
      unrelated.kill("SIGKILL");
    }
  });

  it("uses a shared root in place and never seeds or deletes it", async () => {
    const appRoot = await createScratchDirectory("eve-host-shared-");
    await mkdir(join(appRoot, "project"));
    await writeFile(join(appRoot, "project", "README.md"), "mine");
    const provider = createHostProvider({ root: "project" });
    await provider.prepare({
      appRoot,
      seedFiles: [
        { content: "seeded", path: "/workspace/seed.md" },
        { content: "# Weather", path: "$HOME/.agents/skills/weather/SKILL.md" },
      ],
    });

    const { handle, state } = await provider.start({ appRoot, sandboxName: "session-shared" });
    expect(state.root).toBe(join(appRoot, "project"));
    expect((await handle.sandbox.run({ command: "cat README.md" })).stdout).toBe("mine");
    expect(await readdir(state.root)).toEqual(["README.md"]);
    expect(
      await handle.sandbox.readTextFile({
        path: await resolveSandboxModelPath({
          path: "$HOME/.agents/skills/weather/SKILL.md",
          sandbox: handle.sandbox,
        }),
      }),
    ).toBe("# Weather");

    await handle.onSandboxDelete();
    await provider.endSession(appRoot, "session-shared");
    expect(await readFile(join(appRoot, "project", "README.md"), "utf8")).toBe("mine");
    expect(await readdir(join(appRoot, "host", "sessions"))).toEqual([]);
  });

  describe("environment", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("inherits the launch environment without values loaded from .env files", async () => {
      const appRoot = await createScratchDirectory("eve-host-env-");
      await writeFile(
        join(appRoot, ".env.local"),
        "EVE_HOST_FROM_FILE=file\nEVE_HOST_FROM_SHELL=file\n",
      );
      vi.stubEnv("EVE_HOST_FROM_FILE", "file");
      vi.stubEnv("EVE_HOST_FROM_SHELL", "shell");
      const provider = createHostProvider();
      const { sandbox } = await provider.openSession({ appRoot, sandboxName: "session-env" });

      const result = await sandbox.run({
        command:
          'printf "%s|%s|%s|%s" "${EVE_HOST_FROM_FILE-unset}" "$EVE_HOST_FROM_SHELL" "$AI_AGENT" "$CALL"',
        env: { CALL: "call" },
      });

      expect(result.stdout).toBe("unset|shell|eve|call");
    });

    it("leaves out eve's own runtime variables and model credentials", async () => {
      const appRoot = await createScratchDirectory("eve-host-env-");
      const stripped = [
        "AI_GATEWAY_API_KEY",
        "EVE_DEV",
        "EVE_DEV_WORKFLOW_TRANSPORT_SECRET",
        "EVE_EVALUATION_RUN_ID",
        "EVE_MODEL_TEAM",
        "PORT",
        "VERCEL_OIDC_TOKEN",
        "WORKFLOW_LOCAL_BASE_URL",
      ];
      for (const key of stripped) vi.stubEnv(key, "set");
      vi.stubEnv("EVE_HOST_KEPT", "kept");
      const { sandbox } = await createHostProvider().openSession({
        appRoot,
        sandboxName: "session-env-strip",
      });

      const result = await sandbox.run({
        command: `env | cut -d= -f1 | grep -x -e ${[...stripped, "EVE_HOST_KEPT"].join(" -e ")}`,
      });

      expect(result.stdout.trim()).toBe("EVE_HOST_KEPT");
    });
  });
});
