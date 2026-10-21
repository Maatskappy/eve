import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSandboxProviderHarness } from "#internal/testing/sandbox-provider-harness.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import {
  getBoundSandboxEnvironment,
  getSandboxEnvironmentRuntime,
  type SandboxSelectorContext,
} from "#shared/sandbox-environment.js";

import {
  createDevelopmentRuntimeCompiledArtifactsSource,
  getRuntimeCompiledArtifactsSandboxAppRoot,
} from "#runtime/compiled-artifacts-source.js";
import {
  getLocalDevCapability,
  installLocalDevCapabilityEnvironment,
} from "#runtime/local-dev-capability.js";

import { LOCAL_SOURCE_PATH, selfModificationSourceRoot } from "./paths.js";
import editFile from "./extension/subagents/agent/tools/edit_file.js";
import { defineSelfModificationSandbox } from "./sandbox.js";

const createScratchDirectory = useTemporaryDirectories();

afterEach(() => vi.unstubAllEnvs());

describe("local self-modification sandbox", () => {
  it("roots edit_file containment at the app root the instructions name, not the runtime snapshot", async () => {
    vi.stubEnv("EVE_DEV", "1");
    const appRoot = await createScratchDirectory("eve-self-modification-app-");
    const snapshotRoot = await createScratchDirectory("eve-self-modification-snapshot-");
    await mkdir(join(appRoot, "agent"));
    const restore = installLocalDevCapabilityEnvironment({
      appRoot,
      serverUrl: "http://127.0.0.1:3000",
    });
    try {
      // Every dev generation source comes from this helper, and ensure.ts opens sandboxes
      // at its sandbox app root; the instructions name the capability's root.
      const sandboxAppRoot = getRuntimeCompiledArtifactsSandboxAppRoot(
        createDevelopmentRuntimeCompiledArtifactsSource({ appRoot, runtimeAppRoot: snapshotRoot }),
      );
      const environment = getBoundSandboxEnvironment(defineSelfModificationSandbox());
      expect(environment?.provider).toBe("host");
      const provider = createSandboxProviderHarness(
        getSandboxEnvironmentRuntime(environment!).implementation,
        undefined,
      );

      const { sandbox } = await provider.openSession({
        appRoot: sandboxAppRoot!,
        sandboxName: "self-modification",
      });

      expect(selfModificationSourceRoot(sandbox)).toBe(
        join(getLocalDevCapability()!.appRoot, LOCAL_SOURCE_PATH),
      );
      expect((await sandbox.run({ command: "pwd -P" })).stdout.trim()).toBe(
        await realpath(appRoot),
      );
    } finally {
      restore();
    }
  });

  it("keeps edit_file inside agent/ when symlinks point outside it", async () => {
    vi.stubEnv("EVE_DEV", "1");
    const appRoot = await createScratchDirectory("eve-self-modification-links-");
    const outside = await createScratchDirectory("eve-self-modification-outside-");
    await mkdir(join(appRoot, "agent"));
    await writeFile(join(appRoot, "agent", "real.ts"), "old");
    await writeFile(join(outside, "secret.ts"), "old");
    await symlink(outside, join(appRoot, "agent", "linked"));
    await symlink(join(outside, "secret.ts"), join(appRoot, "agent", "file-link.ts"));
    const environment = getBoundSandboxEnvironment(defineSelfModificationSandbox());
    const { sandbox } = await createSandboxProviderHarness(
      getSandboxEnvironmentRuntime(environment!).implementation,
      undefined,
    ).openSession({ appRoot, sandboxName: "self-modification-links" });
    const edit = (path: string) =>
      editFile.execute({ edits: [{ newText: "new", oldText: "old" }], path }, {
        getSandbox: async () => sandbox,
      } as never);

    await expect(edit("agent/real.ts")).resolves.toMatchObject({ replacements: 1 });
    await expect(edit("agent/linked/secret.ts")).rejects.toThrow("must stay below");
    await expect(edit("agent/file-link.ts")).rejects.toThrow("must stay below");
    await expect(readFile(join(outside, "secret.ts"), "utf8")).resolves.toBe("old");
  });

  it("binds a prewarm-safe environment that cannot open outside eve dev", async () => {
    vi.stubEnv("EVE_DEV", "0");
    const selector = defineSelfModificationSandbox();
    const environment = getBoundSandboxEnvironment(selector);

    expect(environment?.provider).toBe("vercel");
    await expect(selector({ session: { id: "child" } } as SandboxSelectorContext)).rejects.toThrow(
      "Local self-modification runs only during `eve dev`",
    );
  });
});
