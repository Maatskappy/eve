import { defineSandbox } from "#public/definitions/sandbox.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { DefaultSandbox } from "#sandbox/providers.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";

export function createStubSandboxRegistry(
  environment: SandboxEnvironment = DefaultSandbox.environment(),
): RuntimeSandboxRegistry {
  return {
    sandbox: {
      definition: {
        environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        revisionHash: "stub-sandbox-revision",
        selector: defineSandbox(() => environment.open()),
        sourceId: "test:stub-sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: {
        logicalPath: "test:stub-sandbox/workspace",
        rootEntries: [],
      },
    },
  };
}
