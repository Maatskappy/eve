import { defineEval } from "eve/evals";

// Mirrors the subagent's prepared and written notes; on Vercel the subagent uses Vercel Sandbox.
const PREPARED = "just-bash-prepared-K4T";
const WRITTEN = "just-bash-written-M2P";

export default defineEval({
  description:
    "Sandbox: the just-bash backend guide runs commands over prepared and written files.",
  async test(t) {
    const turn = await t.send(
      "Ask the `just-bash` subagent with message: " +
        "Alice is checking the notes workspace. Verify the notes.",
    );
    turn.expectOk();
    const started = turn.events.find(
      (event) => event.type === "agent.started" && event.data.name === "just-bash",
    );
    if (started?.type !== "agent.started") {
      throw new Error("The turn did not call the just-bash subagent.");
    }

    // Asserts the tool's output, not the model's paraphrase of it.
    const childTurn = await t.target.watchTurn(started.data.sessionId).result();
    childTurn.expectOk();

    t.succeeded();
    t.calledSubagent("just-bash", { count: 1, status: "completed" });
    childTurn.calledTool("verify-just-bash", {
      output: new RegExp(`${PREPARED}\\n${WRITTEN}\\nagent=eve`),
    });
  },
});
