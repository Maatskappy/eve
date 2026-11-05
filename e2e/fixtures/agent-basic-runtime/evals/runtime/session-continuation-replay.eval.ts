import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

interface AcceptedContinuation {
  readonly sessionId: string;
  readonly operationId: string;
  readonly deliveryId: string;
  readonly status: "accepted";
}

export default defineEval({
  description:
    "Alice retries one accepted follow-up without sending another message, including after the session ends.",
  async test(t) {
    const headers = {
      authorization: "Bearer e2e-create-once-a",
      "content-type": "application/json",
    };
    const health = await t.target.fetch("/eve/v1/health", { headers });
    await t.require(health.headers.get("x-eve-continuation-replay"), equals("operation-id-v1"));
    const first = await t.send("Alice opens a planning conversation. Greet her briefly.");
    const sessionId = first.sessionId;
    const operationId = crypto.randomUUID();
    const message = "Alice chooses a blue heading for the plan. Confirm her choice briefly.";
    const path = `/eve/v1/session/${encodeURIComponent(sessionId)}`;
    const send = async (text = message): Promise<AcceptedContinuation> => {
      const response = await t.target.fetch(path, {
        headers,
        method: "POST",
        body: JSON.stringify({ operationId, message: text }),
      });
      if (response.status !== 202)
        throw new Error(`Continuation failed (${response.status}): ${await response.text()}`);
      return (await response.json()) as AcceptedContinuation;
    };
    try {
      const watched = t.target.watchTurn(sessionId, { startIndex: first.events.length });
      const [accepted, concurrent] = await Promise.all([send(), send()]);
      await t.require(
        accepted,
        satisfies(
          (value: AcceptedContinuation) =>
            value.sessionId === sessionId &&
            value.operationId === operationId &&
            typeof value.deliveryId === "string" &&
            value.deliveryId.length > 0,
          "the accepted receipt identifies the exact continuation",
        ),
      );
      await t.require(concurrent, equals(accepted));
      const turn = await watched.result();
      turn.expectOk();
      turn.event("message.received", { count: 1, data: { message } });
      await t.require(await send(), equals(accepted));
      const conflict = await t.target.fetch(path, {
        headers,
        method: "POST",
        body: JSON.stringify({ operationId, message: "Alice chooses a red heading instead." }),
      });
      await t.require(conflict.status, equals(409));
      const reset = await t.target.fetch(`${path}/reset`, { headers, method: "POST" });
      if (!reset.ok) throw new Error(`Session reset failed (${reset.status})`);
      await t.require(await send(), equals(accepted));
    } finally {
      await t.target.fetch(`${path}/reset`, { headers, method: "POST" });
    }
  },
});
