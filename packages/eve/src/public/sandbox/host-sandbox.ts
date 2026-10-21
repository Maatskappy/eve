import type { SandboxSession } from "#shared/sandbox-session.js";

/**
 * Options for a `HostSandbox` environment. Commands run with this machine's
 * `bash`, as the user that started eve; the host sandbox is not an isolation
 * boundary.
 *
 * Without `root`, each session gets its own directory under
 * `.eve/sandbox-cache/host`, seeded from `agent/sandbox/workspace` and
 * `prepare`. With `root`, every session shares that existing directory and eve
 * never seeds or deletes it.
 */
export type HostSandboxEnvironmentOptions =
  | {
      /** Idempotent setup captured in the template each session copies. */
      readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
      readonly root?: never;
    }
  | {
      readonly prepare?: never;
      /**
       * Existing directory every session uses as its workspace root, resolved
       * from the app root (for example `"."`). eve does not copy workspace
       * files into it and never deletes it.
       */
      readonly root: string;
    };
