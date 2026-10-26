// Retained tool epoch 102: optional inbox delivery state preserves existing sandbox tools.
import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Archive Alice's notes and pause the sandbox.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    await sandbox.writeFiles({
      files: [{ content: new TextEncoder().encode("Feed the cat."), path: "notes/alice.txt" }],
    });
    const result = await sandbox.run({ command: "tar -czf notes.tgz notes" });
    await sandbox.stop();
    return { exitCode: result.exitCode };
  },
});
