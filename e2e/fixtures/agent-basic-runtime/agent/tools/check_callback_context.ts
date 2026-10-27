import { setCallbackData } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Check whether this conversation has a native completion callback.",
  inputSchema: z.strictObject({}),
  execute() {
    try {
      setCallbackData({ report: "callback-context-check" });
      return { accepted: true };
    } catch (error) {
      return { accepted: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
});
