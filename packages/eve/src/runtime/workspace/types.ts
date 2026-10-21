/**
 * Workspace root for providers that own a dedicated filesystem (Vercel,
 * Docker). It is both where authored workspace files are seeded and the live
 * `bash` cwd there. Providers declare their real root through `resolvePath`,
 * so code that needs the root of an open sandbox reads `sandboxWorkspaceRoot`.
 */
export const WORKSPACE_ROOT = "/workspace";

/**
 * Runtime-facing workspace summary rendered into the prompt.
 *
 * Carries only the lexicographically sorted root entries visible at the
 * live workspace cwd. Seed file bytes do not flow through this type.
 */
export interface WorkspaceRuntimeSpec {
  readonly rootEntries: readonly string[];
}
