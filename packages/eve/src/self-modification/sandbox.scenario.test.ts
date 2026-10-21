import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSandboxProviderHarness } from "#internal/testing/sandbox-provider-harness.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import {
  getBoundSandboxEnvironment,
  getSandboxEnvironmentRuntime,
  type SandboxSelectorContext,
} from "#shared/sandbox-environment.js";

import { defineSelfModificationSandbox } from "./sandbox.js";

const createScratchDirectory = useTemporaryDirectories();

afterEach(() => vi.unstubAllEnvs());

describe("local self-modification sandbox", () => {
  it("runs in the authored application directory during eve dev", async () => {
    vi.stubEnv("EVE_DEV", "1");
    const appRoot = await createScratchDirectory("eve-self-modification-sandbox-");
    await mkdir(join(appRoot, "agent"));
    await writeFile(join(appRoot, "agent", "instructions.md"), "authored\n");
    const environment = getBoundSandboxEnvironment(defineSelfModificationSandbox());
    expect(environment?.provider).toBe("host");
    const provider = createSandboxProviderHarness(
      getSandboxEnvironmentRuntime(environment!).implementation,
      undefined,
    );

    const { sandbox } = await provider.openSession({ appRoot, sandboxName: "self-modification" });

    expect((await sandbox.run({ command: "pwd -P" })).stdout.trim()).toBe(await realpath(appRoot));
    expect(await sandbox.readTextFile({ path: "agent/instructions.md" })).toBe("authored\n");
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
