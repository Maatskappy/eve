import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

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

    t.succeeded();
    t.calledSubagent("just-bash", { count: 1, status: "completed" });
    t.check(turn.message, includes(PREPARED));
    t.check(turn.message, includes(WRITTEN));
    t.check(turn.message, includes("eve"));
  },
});
