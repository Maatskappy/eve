// Retained channel epoch 69: optional inbox delivery state preserves existing authoring.
import { defineChannel } from "#public/channels/index.js";

export default defineChannel({
  routes: [],
  events: {
    "turn.completed": async (_event, _channel, ctx) => {
      const sandbox = await ctx.getSandbox();
      await sandbox.writeFiles({
        files: [{ content: new TextEncoder().encode("Sent to Alice."), path: "reports/sent.txt" }],
      });
    },
  },
});
