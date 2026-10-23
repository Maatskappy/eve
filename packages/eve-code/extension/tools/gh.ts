import {
  GH_TOOL_DESCRIPTION,
  ghToolApproval,
  ghToolOutputSchema,
  githubShellInputSchema,
  runGhTool,
} from "eve/extensions/git/sandbox";
import { defineDynamic, defineTool } from "eve/tools";

import extension from "../extension.ts";

/**
 * @deprecated Mount `eve/extensions/git` with `github` config.
 *
 * Defined inline, not with the static `gh` from `github-compat.ts`: a dynamic
 * tool's callbacks may only capture JSON values, so `execute` reads the config
 * from the module-level `extension` import.
 */
export default defineDynamic({
  events: {
    "session.started": () =>
      extension.config.github === undefined
        ? null
        : defineTool({
            description: GH_TOOL_DESCRIPTION,
            approval: ghToolApproval,
            inputSchema: githubShellInputSchema,
            outputSchema: ghToolOutputSchema,
            execute(input, ctx) {
              return runGhTool(input, ctx, extension.config.github);
            },
          }),
  },
});
