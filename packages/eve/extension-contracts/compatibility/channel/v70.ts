import { defineChannel } from "#public/channels/index.js";

export default defineChannel({
  routes: [],
  events: {
    async "turn.settled"(event, ctx) {
      const sandbox = await ctx.getSandbox();
      await sandbox.writeTextFile({ path: "reports/outcome.txt", content: event.data.outcome });
    },
  },
});
