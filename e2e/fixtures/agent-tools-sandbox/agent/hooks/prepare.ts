import { defineHook } from "eve/hooks";

export default defineHook({
  async prewarm(ctx) {
    await ctx.preload("sandbox", async (sandbox) => {
      await sandbox.writeTextFile({
        path: "/workspace/prewarm-session.txt",
        content: ctx.session.id,
      });
    });
  },
});
