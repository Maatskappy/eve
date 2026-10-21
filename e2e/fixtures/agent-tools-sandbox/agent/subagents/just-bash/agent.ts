import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

export default defineAgent({
  description: "Verifies the just-bash backend from the sandbox docs.",
  ...e2eSubagentConfig({ mock: respond }),
});

function respond(request: MockModelRequest): MockModelResponse | string {
  const result = request.toolResults.find((entry) => entry.name === "verify-just-bash");
  return result === undefined
    ? { toolCalls: [{ input: {}, name: "verify-just-bash" }] }
    : String(result.output);
}
