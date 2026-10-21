export {
  defineSandboxProvider,
  type SandboxDeleteOptions,
  type SandboxPreparedArtifact,
  type SandboxProvider,
  type SandboxProviderDefinition,
  type SandboxProviderFiles,
  type SandboxProviderHandle,
  type SandboxProviderImplementation,
  type SandboxProviderPrepareContext,
  type SandboxProviderResourceFile,
  type SandboxProviderResources,
  type SandboxProviderResourceSource,
  type SandboxProviderResourceTree,
  type SandboxProviderSessionContext,
  type SandboxProviderTargetFile,
} from "#shared/sandbox-provider.js";

/**
 * Throw from a provider's `resume()` when the session's native sandbox no
 * longer exists, for example after its container, VM, or directory was removed
 * outside eve. eve then clears the session's sandbox state and reruns the
 * sandbox selector, whose `start()` creates a fresh sandbox, as after
 * `sandbox.delete()`. Any other error from `resume()` leaves the state in place,
 * so every sandbox call in that session fails with it until the session ends.
 */
export { SandboxSessionGoneError } from "#shared/sandbox-session-gone-error.js";

export {
  defineSandboxBackend,
  type SandboxBackendContext,
  type SandboxBackendData,
  type SandboxBackendDataStream,
  type SandboxBackendDefinition,
  type SandboxBackendEnvironmentOptions,
  type SandboxBackendExecOptions,
  type SandboxBackendExecResult,
  type SandboxBackendInstance,
  type SandboxBackendProcess,
} from "#execution/sandbox/backend.js";
