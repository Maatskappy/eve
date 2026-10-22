import { endsTurn, type SessionStreamEvent } from "eve/client";
import type { ChildOpened } from "eve/events";
import { defineEval, type EveEvalContext, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { MODEL_AGENT_SELECTED_MODEL } from "../constants";

export default defineEval({
  description:
    "An opt-in custom agent tool selects a child model while the default agent tool keeps its original input.",
  async test(t) {
    const turn = await t.send(
      "E2E_MODEL_SELECTING_AGENT_TOOL Alice asks two root copies to review the same sample plan.",
    );

    turn.expectOk();
    turn.messageIncludes("DEFAULT_AGENT_MODEL_OK");
    turn.messageIncludes("SELECTED_AGENT_MODEL_OK");
    turn.calledTool("model_agent", {
      count: 1,
      input: {
        message: "Reply with exactly SELECTED_AGENT_MODEL_OK",
        model: MODEL_AGENT_SELECTED_MODEL,
      },
    });

    const opened = await requireSelectedChild(t, turn);
    const childEvents: SessionStreamEvent[] = [];
    for await (const event of turn.session.agent(opened).stream()) {
      childEvents.push(event);
      if (endsTurn(event)) break;
    }

    await t.require(
      childEvents,
      satisfies(
        (events: readonly SessionStreamEvent[]) =>
          events.some(
            (event) =>
              event.type === "model.started" && event.data.modelId === MODEL_AGENT_SELECTED_MODEL,
          ),
        `the custom agent tool starts its child with ${MODEL_AGENT_SELECTED_MODEL}`,
      ),
    );
    t.succeeded();
    t.noFailedCalls();
  },
});

async function requireSelectedChild(t: EveEvalContext, turn: EveEvalTurn): Promise<ChildOpened> {
  const call = turn.events.find(
    (event) => event.type === "call.started" && event.data.callId === "model-agent-call",
  );
  if (call?.type !== "call.started") throw new Error("The custom agent call did not start.");
  const owner =
    call.data.taskId === undefined ? { callId: call.data.callId } : { taskId: call.data.taskId };
  for (const event of turn.events) {
    if (
      event.type === "child.opened" &&
      ("callId" in owner
        ? "callId" in event.data.owner && event.data.owner.callId === owner.callId
        : "taskId" in event.data.owner && event.data.owner.taskId === owner.taskId)
    ) {
      return event;
    }
  }
  return await t.target
    .attach(turn.sessionId, { startIndex: turn.session.state.streamIndex })
    .watch()
    .waitForEvent("child.opened", { data: { owner } });
}
