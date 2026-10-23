import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Read Alice's saved note.",
  inputSchema: {},
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    return await sandbox.readTextFile({ path: "notes/alice.txt" });
  },
});
