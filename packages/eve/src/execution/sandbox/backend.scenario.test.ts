import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createSandboxBackendImplementation,
  defineSandboxBackend,
  type InternalSandboxBackendDefinition,
  type SandboxBackendDefinition,
  type SandboxBackendEnvironmentOptions,
  type SandboxBackendExecOptions,
  type SandboxBackendExecResult,
  type SandboxBackendInstance,
  type SandboxBackendProcess,
} from "#execution/sandbox/backend.js";
import { createSandboxProviderHarness } from "#internal/testing/sandbox-provider-harness.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { SandboxSessionGoneError } from "#shared/sandbox-session-gone-error.js";

const createScratchDirectory = useTemporaryDirectories();

const HOME = "/home/memory";
const SKILLS = `${HOME}/.agents/skills`;
const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);
const emptyStream = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });

type Exec = (
  options: SandboxBackendExecOptions,
) => SandboxBackendExecResult | SandboxBackendProcess | Promise<SandboxBackendExecResult>;

// The test runner may itself run inside an eve sandbox; the fake must not inherit its roots.
const {
  EVE_SANDBOX_JOB_ROOT: _jobRoot,
  EVE_SANDBOX_SKILL_ROOT: _skillRoot,
  ...SHELL_ENV
} = process.env;

/** Runs commands the test does not script in a real shell whose `$HOME` is the fake's. */
const shell: Exec = (options) => {
  const result = spawnSync("bash", ["-c", options.command], {
    encoding: "utf8",
    env: { ...SHELL_ENV, ...options.env, HOME },
  });
  return { exitCode: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
};

interface MemorySandbox {
  readonly execs: SandboxBackendExecOptions[];
  readonly files: Map<string, Uint8Array>;
}

/** A backend whose sandboxes are in-memory file maps keyed by the session's sandbox key. */
function createMemoryBackend(exec: Exec = shell) {
  const sandboxes = new Map<string, MemorySandbox>();
  const events: string[] = [];
  const instance = (sandbox: MemorySandbox): SandboxBackendInstance => ({
    exec(options) {
      sandbox.execs.push(options);
      return exec(options);
    },
    readFile: (path) => sandbox.files.get(path) ?? null,
    writeFile(path, content) {
      sandbox.files.set(path, content);
    },
    removePath({ path }) {
      for (const key of [...sandbox.files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) sandbox.files.delete(key);
      }
    },
    stop() {
      events.push("stop");
    },
  });
  const definition: SandboxBackendDefinition = {
    name: "memory",
    workspaceRoot: "/workspace",
    async open(context) {
      const existing = sandboxes.get(context.key);
      if (existing !== undefined) return { instance: instance(existing) };
      const sandbox: MemorySandbox = { execs: [], files: new Map() };
      sandboxes.set(context.key, sandbox);
      return { created: true, instance: instance(sandbox) };
    },
    async find(context) {
      const sandbox = sandboxes.get(context.key);
      return sandbox === undefined ? undefined : instance(sandbox);
    },
    async remove(context) {
      events.push("remove");
      sandboxes.delete(context.key);
    },
  };
  return { definition, events, sandboxes };
}

function harness(
  definition: InternalSandboxBackendDefinition<object>,
  options: SandboxBackendEnvironmentOptions = {},
) {
  return createSandboxProviderHarness(
    createSandboxBackendImplementation(definition, options),
    undefined,
  );
}

/** A directory-backed backend: sandbox paths live under `context.directory`. */
function createDirectoryBackend(): SandboxBackendDefinition {
  return {
    name: "directory",
    workspaceRoot: "/workspace",
    directoryTemplate: true,
    async open(context) {
      const path = (sandboxPath: string) => join(context.directory, sandboxPath);
      return {
        instance: {
          exec: shell,
          readFile: async (sandboxPath) => await readFile(path(sandboxPath)).catch(() => null),
          async writeFile(sandboxPath, content) {
            await mkdir(dirname(path(sandboxPath)), { recursive: true });
            await writeFile(path(sandboxPath), content);
          },
          async removePath({ path: sandboxPath }) {
            await rm(path(sandboxPath), { force: true, recursive: true });
          },
        },
      };
    },
  };
}

describe("defineSandboxBackend", () => {
  it("seeds only the sandbox open creates, and refreshes authored skills on a rebuild", async () => {
    const appRoot = await createScratchDirectory("eve-backend-upsert-");
    const { definition, sandboxes } = createMemoryBackend();
    const prepare = vi.fn(async (sandbox: SandboxSession) => {
      await sandbox.writeTextFile({ content: "yes", path: "prepared.txt" });
    });
    const provider = harness(definition, { prepare });
    await provider.prepare({
      appRoot,
      seedFiles: [
        { content: "first", path: "/workspace/notes/seed.md" },
        { content: "# Weather v1", path: "$HOME/.agents/skills/weather/SKILL.md" },
        { content: "# Retired", path: "$HOME/.agents/skills/retired/SKILL.md" },
      ],
      sourceRevision: "first",
    });
    const first = await provider.start({ appRoot, sandboxName: "session-a" });
    // A dynamic skill shares the skill root with the authored ones.
    await first.handle.sandbox.writeTextFile({
      content: "# Tenant",
      path: `${SKILLS}/tenant/SKILL.md`,
    });
    const files = sandboxes.get(first.state.key)!.files;
    expect(text(files.get("/workspace/notes/seed.md"))).toBe("first");
    expect(text(files.get("/workspace/prepared.txt"))).toBe("yes");

    const rebuilt = await provider.prepare({
      appRoot,
      seedFiles: [
        { content: "second", path: "/workspace/notes/seed.md" },
        { content: "# Weather v2", path: "$HOME/.agents/skills/weather/SKILL.md" },
      ],
      sourceRevision: "second",
    });
    const again = await provider.start({ appRoot, prepared: rebuilt, sandboxName: "session-a" });

    expect(again.state).toEqual(first.state);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(text(files.get("/workspace/notes/seed.md"))).toBe("first");
    expect(text(files.get(`${SKILLS}/weather/SKILL.md`))).toBe("# Weather v2");
    expect(files.has(`${SKILLS}/retired/SKILL.md`)).toBe(false);
    expect(text(files.get(`${SKILLS}/tenant/SKILL.md`))).toBe("# Tenant");
  });

  it("runs commands with AI_AGENT=eve and normalizes finished and streaming output", async () => {
    const appRoot = await createScratchDirectory("eve-backend-exec-");
    const { definition, sandboxes } = createMemoryBackend((options) => {
      if (options.command === "finished") {
        return { exitCode: 3, stderr: new TextEncoder().encode("err"), stdout: "out" };
      }
      if (options.command === "streaming") {
        return {
          exited: Promise.resolve(0),
          kill() {},
          stderr: emptyStream(),
          stdout: (async function* () {
            yield "a";
            yield new TextEncoder().encode("b");
          })(),
        };
      }
      return shell(options);
    });
    const { handle, state } = await harness(definition).start({ appRoot, sandboxName: "exec" });

    await expect(
      handle.sandbox.run({ command: "finished", env: { CALL: "call" }, workingDirectory: "sub" }),
    ).resolves.toEqual({ exitCode: 3, stderr: "err", stdout: "out" });
    expect(sandboxes.get(state.key)!.execs.at(-1)).toMatchObject({
      cwd: "/workspace/sub",
      env: { AI_AGENT: "eve", CALL: "call" },
    });
    await expect(handle.sandbox.run({ command: "streaming" })).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "ab",
    });
  });

  it("rejects an aborted command, killing a streaming one and signalling a finished one", async () => {
    const appRoot = await createScratchDirectory("eve-backend-abort-");
    const kill = vi.fn();
    const { definition } = createMemoryBackend((options) => {
      if (options.command === "streaming") {
        let finish = (_code: number) => {};
        return {
          exited: new Promise<number>((resolve) => (finish = resolve)),
          kill() {
            kill();
            finish(137);
          },
          stderr: emptyStream(),
          stdout: emptyStream(),
        };
      }
      if (options.command === "finished") {
        // An engine that honors the signal and returns once the command stops.
        return new Promise<SandboxBackendExecResult>((resolve) =>
          options.signal?.addEventListener("abort", () =>
            resolve({ exitCode: 130, stderr: "", stdout: "" }),
          ),
        );
      }
      return shell(options);
    });
    const { handle } = await harness(definition).start({ appRoot, sandboxName: "abort" });

    for (const command of ["streaming", "finished"]) {
      const controller = new AbortController();
      const process = await handle.sandbox.spawn({ abortSignal: controller.signal, command });
      controller.abort(new Error(`stop ${command}`));
      await expect(process.wait()).rejects.toThrow(`stop ${command}`);
    }
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("stops the sandbox for stop and shutdown, and stops then removes it for delete", async () => {
    const appRoot = await createScratchDirectory("eve-backend-lifecycle-");
    const { definition, events } = createMemoryBackend();
    const { handle } = await harness(definition).start({ appRoot, sandboxName: "lifecycle" });

    await handle.onSandboxStop();
    await handle.onRuntimeShutdown();
    await handle.onSandboxDelete();

    expect(events).toEqual(["stop", "stop", "stop", "remove"]);
  });

  it("reports a sandbox that no longer exists or has another key as gone", async () => {
    const appRoot = await createScratchDirectory("eve-backend-gone-");
    const { definition, events, sandboxes } = createMemoryBackend();
    const provider = harness(definition);
    const first = await provider.start({ appRoot, sandboxName: "session-a" });
    const second = await provider.start({ appRoot, sandboxName: "session-b" });

    // A key from elsewhere, such as before the app moved, names a sandbox this session cannot find.
    await expect(
      provider.openSession({ appRoot, existing: second.state, sandboxName: "session-a" }),
    ).rejects.toBeInstanceOf(SandboxSessionGoneError);
    expect(events).toEqual([]);

    sandboxes.delete(first.state.key);
    await expect(
      provider.openSession({ appRoot, existing: first.state, sandboxName: "session-a" }),
    ).rejects.toBeInstanceOf(SandboxSessionGoneError);
    expect(events).toEqual([]);

    // A `directoryTemplate` backend without `find` is gone once its directory is.
    const directoryBackend = harness(createDirectoryBackend());
    const { state } = await directoryBackend.start({ appRoot, sandboxName: "session-c" });
    await rm(join(appRoot, "directory", "sessions"), { force: true, recursive: true });
    await expect(
      directoryBackend.openSession({ appRoot, existing: state, sandboxName: "session-c" }),
    ).rejects.toBeInstanceOf(SandboxSessionGoneError);
  });

  it("never removes a sandbox that a concurrent start created while a stale resume ran", async () => {
    const appRoot = await createScratchDirectory("eve-backend-resume-race-");
    const { definition, events, sandboxes } = createMemoryBackend();
    let findLooked = false;
    let releaseFind = () => {};
    const findHeld = new Promise<void>((resolve) => (releaseFind = resolve));
    const provider = harness({
      ...definition,
      // The stale resume looks before the concurrent start creates, and finishes after.
      async find(context, options) {
        const found = await definition.find!(context, options);
        findLooked = true;
        await findHeld;
        return found;
      },
    });
    const { state } = await provider.start({ appRoot, sandboxName: "session-a" });
    sandboxes.delete(state.key);

    const staleResume = provider.openSession({
      appRoot,
      existing: state,
      sandboxName: "session-a",
    });
    await vi.waitFor(() => expect(findLooked).toBe(true));
    const fresh = await provider.start({ appRoot, sandboxName: "session-a" });
    releaseFind();

    await expect(staleResume).rejects.toBeInstanceOf(SandboxSessionGoneError);
    expect(sandboxes.has(fresh.state.key)).toBe(true);
    expect(events).not.toContain("remove");
  });

  it("removes a sandbox whose seeding fails, so the next start creates a fresh one", async () => {
    const appRoot = await createScratchDirectory("eve-backend-seed-failure-");
    const { definition, events, sandboxes } = createMemoryBackend();
    let failures = 1;
    const provider = harness(definition, {
      async prepare(sandbox) {
        await sandbox.writeTextFile({ content: "half", path: "half.txt" });
        if (failures-- > 0) throw new Error("prepare failed");
      },
    });

    await expect(provider.start({ appRoot, sandboxName: "session-a" })).rejects.toThrow(
      "prepare failed",
    );
    expect(events).toEqual(["stop", "remove"]);
    expect(sandboxes.size).toBe(0);

    const { state } = await provider.start({ appRoot, sandboxName: "session-a" });
    expect(text(sandboxes.get(state.key)!.files.get("/workspace/half.txt"))).toBe("half");
  });

  it("removes the session directory by default, idempotently, when the session ends", async () => {
    const appRoot = await createScratchDirectory("eve-backend-remove-");
    const provider = harness(createDirectoryBackend());
    await provider.start({ appRoot, sandboxName: "session-a" });
    const sessions = join(appRoot, "directory", "sessions");
    expect(await readdir(sessions)).toHaveLength(1);

    await provider.endSession({ appRoot, sandboxName: "session-a", state: null });
    await provider.endSession({ appRoot, sandboxName: "session-a", state: null });
    await provider.endSession({ appRoot, sandboxName: "never-started", state: null });

    expect(await readdir(sessions)).toEqual([]);
  });

  it("prepares a directory template once per build input and copies it into each session", async () => {
    const appRoot = await createScratchDirectory("eve-backend-template-");
    const prepare = vi.fn(async (sandbox: SandboxSession) => {
      await sandbox.writeTextFile({ content: "prepared", path: "prepared.txt" });
    });
    const provider = harness(createDirectoryBackend(), { prepare });
    const build = (sourceRevision: string) =>
      provider.prepare({
        appRoot,
        seedFiles: [{ content: "seeded", path: "/workspace/seed.md" }],
        sourceRevision,
      });

    const artifact = await build("first");
    expect(await build("first")).toEqual(artifact);
    expect(prepare).toHaveBeenCalledTimes(1);
    const sessions = await Promise.all(
      ["session-a", "session-b"].map(
        async (sandboxName) =>
          (await provider.start({ appRoot, prepared: artifact, sandboxName })).handle.sandbox,
      ),
    );
    for (const sandbox of sessions) {
      expect(await sandbox.readTextFile({ path: "seed.md" })).toBe("seeded");
      expect(await sandbox.readTextFile({ path: "prepared.txt" })).toBe("prepared");
    }
    await sessions[0]!.writeTextFile({ content: "a", path: "owner.txt" });
    expect(await sessions[1]!.readTextFile({ path: "owner.txt" })).toBeNull();

    expect(await build("second")).not.toEqual(artifact);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(existsSync(join(appRoot, "directory", "templates"))).toBe(true);
  });

  it("rejects built-in provider names and a backend it could not find again", () => {
    const { definition } = createMemoryBackend();
    expect(() => defineSandboxBackend({ ...definition, name: "host" })).toThrow("built-in");
    const { find: _find, ...unfindable } = definition;
    expect(() => defineSandboxBackend(unfindable as SandboxBackendDefinition)).toThrow(
      "must define find()",
    );
  });
});
