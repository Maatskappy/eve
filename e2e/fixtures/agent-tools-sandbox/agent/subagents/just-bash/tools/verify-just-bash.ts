import { defineTool } from "eve/tools";
import { z } from "zod";

export const JUST_BASH_WRITTEN = "just-bash-written-M2P";

export default defineTool({
  description: "Writes a note to the sandbox, then reads it and the prepared file with the shell.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    await sandbox.writeTextFile({ content: JUST_BASH_WRITTEN, path: "notes/written.txt" });
    const result = await sandbox.run({
      command: 'cat prepared.txt; echo; cat notes/written.txt; echo; printf "agent=%s" "$AI_AGENT"',
    });
    return result.stdout;
  },
});
