import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "history.imported": (_event, ctx) => {
      console.info("Imported session history", { sessionId: ctx.session.id });
    },
    "turn.started": (_event, ctx) => {
      if (ctx.session.auth.current === null) ctx.cancel();
    },
  },
});
