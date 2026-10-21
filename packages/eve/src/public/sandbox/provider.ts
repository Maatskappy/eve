import { buildSandboxSession } from "#execution/sandbox/session.js";
import type { InternalSandboxSession, SandboxSession } from "#shared/sandbox-session.js";

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

/**
 * The byte-level operations a custom sandbox engine implements so
 * {@link createSandboxSession} can build a full {@link SandboxSession}.
 *
 * - `spawn` starts one shell command and streams its output.
 * - `readFile` returns a file's bytes, or `null` when it does not exist.
 * - `writeFile` writes a byte stream, creating parent directories.
 * - `removePath` removes a file or directory.
 * - `resolvePath` anchors relative paths at the engine's workspace root and
 *   passes absolute paths through. `resolvePath(".")` is the workspace root eve
 *   reports to tools.
 *
 * eve writes skill packages under the sandbox's `$HOME/.agents/skills`. An
 * engine whose home directory is not its own can set `EVE_SANDBOX_SKILL_ROOT`
 * to an absolute directory in every command's environment instead.
 *
 * eve resolves every path through `resolvePath` before it calls `readFile`,
 * `writeFile`, or `removePath`.
 */
export type SandboxSessionPrimitives = InternalSandboxSession;

/**
 * Builds a complete {@link SandboxSession} from a custom engine's
 * {@link SandboxSessionPrimitives}. eve derives `run`, the binary and text
 * read and write variants, text encodings, and line ranges from those
 * primitives, so a provider's handle only adapts its engine.
 *
 * @example
 * ```ts
 * import { createSandboxSession } from "eve/sandbox/provider";
 *
 * const sandbox = createSandboxSession({
 *   resolvePath: (path) => (path.startsWith("/") ? path : `/workspace/${path}`),
 *   spawn: (options) => engine.spawn(options),
 *   readFile: ({ path }) => engine.readFile(path),
 *   writeFile: ({ path, content }) => engine.writeFile(path, content),
 *   removePath: (options) => engine.remove(options),
 * });
 * ```
 */
export function createSandboxSession(primitives: SandboxSessionPrimitives): SandboxSession {
  return buildSandboxSession(primitives);
}
