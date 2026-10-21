import { describe, expect, it } from "vitest";

import { withBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { loadSandboxPreparedArtifact } from "#runtime/sandbox/prepared-artifacts.js";
import { createSandboxPreparedArtifactsManifest } from "#shared/sandbox-prepared-artifacts.js";

describe("loadSandboxPreparedArtifact", () => {
  it("explains a build prepared for another provider than the server selected", async () => {
    const sandboxPreparedArtifacts = createSandboxPreparedArtifactsManifest([
      {
        artifact: { imageReference: "eve-template:v1" },
        nodeId: "__root__",
        providerName: "docker",
      },
    ]);

    await withBundledCompiledArtifacts(
      { manifest: {} as never, moduleMap: {} as never, sandboxPreparedArtifacts },
      async () => {
        const load = loadSandboxPreparedArtifact({
          compiledArtifactsSource: { kind: "bundled" },
          nodeId: "__root__",
          providerName: "host",
        });

        await expect(load).rejects.toThrow(
          'prepared the sandbox for "docker", but this server selected "host"',
        );
        await expect(load).rejects.toThrow(
          "run `eve build` and the server with the same environment",
        );
      },
    );
  });
});
