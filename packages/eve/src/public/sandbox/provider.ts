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
 * - `skillRoot` optionally names the absolute directory where eve writes
 *   skill packages, instead of `$HOME/.agents/skills`.
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
