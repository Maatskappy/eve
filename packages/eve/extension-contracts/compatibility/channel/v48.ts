// Native callback delivery adds a transport event; this existing authored API stays valid.
import { defineChannel, GET } from "#public/channels/index.js";

export default defineChannel({
  routes: [
    GET("/status", async (_request, { describe, invokeTool }) => {
      const { tools } = await describe();
      return Response.json({
        tools: tools.length,
        canInvokeTools: typeof invokeTool === "function",
      });
    }),
  ],
});
