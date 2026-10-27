import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "The authored eve/context callback API rejects data in a direct conversation without a callback.",
  async test(t) {
    const turn = await t.send(
      "Alice checks whether this direct conversation has a completion callback. Call check_callback_context once and report its result.",
    );
    turn.expectOk();
    turn.calledTool("check_callback_context", { count: 1, status: "completed" });
    turn.calledTool("check_callback_context", { output: /"accepted":false/u });
    turn.calledTool("check_callback_context", { output: /no native completion callback/u });
    t.noFailedActions();
  },
});
