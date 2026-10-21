import { posix } from "node:path";

import { defineSandboxBackend } from "eve/sandbox/provider";
import { Bash, type CustomCommand, type IFileSystem, ReadWriteFs } from "just-bash";

export interface JustBashOptions {
  /** Commands written in TypeScript that every shell command can call. */
  readonly customCommands?: CustomCommand[];
  /** Replaces the session filesystem, for example to mount more directories. */
  readonly filesystem?: (session: IFileSystem) => IFileSystem;
}

export const JustBashSandbox = defineSandboxBackend<JustBashOptions>({
  name: "just-bash",
  workspaceRoot: "/workspace",
  // eve prepares one template directory per build and copies it into each session's directory.
  directoryTemplate: true,
  keyedToolSessions: true,
  async open(ctx, options) {
    // eve stages PDFs up to 20 MiB, past just-bash's default 10 MB read limit.
    const root = new ReadWriteFs({ maxFileReadSize: Number.MAX_SAFE_INTEGER, root: ctx.directory });
    const fs = options.filesystem?.(root) ?? root;
    await fs.mkdir("/workspace", { recursive: true });
    const bash = new Bash({
      customCommands: options.customCommands,
      cwd: "/workspace",
      env: { HOME: "/home/agent" },
      fs,
    });
    return {
      instance: {
        exec: ({ command, cwd, env, signal }) =>
          bash.exec(command, { cwd, env: { ...env }, signal }),
        readFile: (path) => fs.readFileBuffer(path).catch(() => null),
        async writeFile(path, content) {
          await fs.mkdir(posix.dirname(path), { recursive: true });
          await fs.writeFile(path, content);
        },
        removePath: ({ force, path, recursive }) => fs.rm(path, { force, recursive }),
      },
    };
  },
});
