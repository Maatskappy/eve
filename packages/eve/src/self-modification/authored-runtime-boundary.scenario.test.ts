import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { bundleAuthoredModuleForGeneration } from "#internal/authored-module-loader.js";

describe("self-modification authored runtime boundary", () => {
  it.each(["agent", "sandbox"])(
    "keeps runtime implementations out of the %s generation",
    async (entry) => {
      const code = await bundleAuthoredModuleForGeneration(
        fileURLToPath(new URL(`./extension/subagents/agent/${entry}.ts`, import.meta.url)),
      );

      expect(code).not.toContain("createHostSandboxProvider");
      expect(code).not.toContain("openHostSandboxHandle");
      if (entry === "sandbox") {
        expect(code).toContain('from "eve/self-modification/sandbox"');
      } else {
        expect(code).toContain('from "eve"');
      }
    },
  );
});
