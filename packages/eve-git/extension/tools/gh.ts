import { defineDynamic, defineTool } from "eve/tools";

import extension from "../extension.ts";
import { GH_TOOL_DESCRIPTION, ghToolOutputSchema, runGhTool } from "../lib/gh-tool.ts";
import { githubShellApproval, type GitHubShellInput } from "../lib/github-shell.ts";
import { githubShellInputSchema } from "../lib/github-shell-schema.ts";

/**
 * Present only with `github` config; otherwise agents use `gh` from their own
 * shell. Defined inline, not with `defineGhTool`: a dynamic tool's callbacks
 * may only capture JSON values, so `execute` reads the config from the
 * module-level `extension` import.
 */
export default defineDynamic({
  events: {
    "session.started": () =>
      extension.config.github === undefined
        ? null
        : defineTool({
            description: GH_TOOL_DESCRIPTION,
            approval: ({ toolInput }) =>
              githubShellApproval(toolInput as GitHubShellInput | undefined),
            inputSchema: githubShellInputSchema,
            outputSchema: ghToolOutputSchema,
            execute(input, ctx) {
              return runGhTool(input, ctx, extension.config.github);
            },
          }),
  },
});
