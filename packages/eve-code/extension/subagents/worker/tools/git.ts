import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import {
  GIT_READ_SUBCOMMANDS,
  gitReadCommand,
  gitReadResult,
  MAX_GIT_OUTPUT_BYTES,
} from "../../../lib/git-read.ts";
import { resolveWorkspaceDirectory } from "../../../lib/workspace-root.ts";

export default defineTool({
  description: [
    "Run a read-only git command in the sandbox workspace, for example",
    '["diff", "--cached"], ["log", "-5", "--", "src/a.ts"], or ["blame", "-L", "10,20", "src/a.ts"].',
    `Allowed subcommands: ${GIT_READ_SUBCOMMANDS.join(", ")}.`,
    `Output beyond ${MAX_GIT_OUTPUT_BYTES / 1024} KiB is truncated: narrow it with a pathspec, -n, or --stat.`,
  ].join("\n"),
  approval: never(),
  label: {
    start: ({ args }) => `git ${args.join(" ")}`,
  },
  inputSchema: z.object({
    root: z
      .string()
      .min(1)
      .optional()
      .describe(
        "absolute directory inside the sandbox workspace to run git in; defaults to the workspace root",
      ),
    args: z
      .array(z.string())
      .min(1)
      .describe("git arguments after `git`, starting with an allowed subcommand"),
  }),
  outputSchema: z.object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
  }),
  async execute({ root, args }, ctx) {
    const sandbox = await ctx.getSandbox();
    const directory = await resolveWorkspaceDirectory(sandbox, root);
    return gitReadResult(
      await sandbox.run({ signal: ctx.abortSignal, command: gitReadCommand(directory, args) }),
    );
  },
});
