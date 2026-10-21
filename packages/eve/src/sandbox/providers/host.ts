import type { SandboxBackendArtifact, SandboxBackendState } from "#execution/sandbox/backend.js";
import { createHostSandboxProvider } from "#execution/sandbox/bindings/local.js";
import { HOST_PROVIDER_NAME } from "#execution/sandbox/host-provider-name.js";
import type { HostSandboxEnvironmentOptions } from "#public/sandbox/host-sandbox.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export type { HostSandboxEnvironmentOptions } from "#public/sandbox/host-sandbox.js";

export const HostSandbox = defineSandboxProvider<
  HostSandboxEnvironmentOptions,
  undefined,
  SandboxBackendArtifact,
  SandboxBackendState,
  SandboxSession
>({
  name: HOST_PROVIDER_NAME,
  environment: (...args) => createHostSandboxProvider(args[0]),
});
