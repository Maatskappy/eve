import { defineTool } from "eve/tools";
import { z } from "zod";

import { NOTE_PATH } from "../../fixture";

// Reads through the shell, from where commands start, so the tool-session eval
// also proves that commands and relative file paths share one workspace root.
export default defineTool({
  description: "Read the note the previous shift left in the sandbox workspace.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    const result = await sandbox.run({ command: `cat ${NOTE_PATH}` });
    if (result.exitCode !== 0) throw new Error(`read_note: ${result.stderr}`);
    return { text: result.stdout };
  },
});
