import { expect, it } from "vitest";
import { admitDeliveries } from "#execution/session/delivery-facts.js";

it("takes answer provenance from admission, not helper fields returned by a delivery hook", () => {
  const alice = {
    authenticator: "test",
    principalId: "alice",
    principalType: "user",
    attributes: {},
  };
  const payload = {};
  const answer = {
    interactionId: "review",
    optionId: "approve",
    text: "Proceed.",
    responder: { ...alice, principalId: "bob" },
    deliveryId: "earlier-delivery",
    responseId: "earlier-response",
  };
  const admitted = admitDeliveries({
    channelKind: "channel:test",
    sessionStarted: true,
    delivery: {
      kind: "deliver",
      auth: alice,
      payloads: [payload],
      deliveryMetadata: [
        { channelKind: "channel:test", channelName: "test", deliveryId: "answer", payloadIndex: 0 },
      ],
    },
    payloads: [{ payload, input: { answers: [answer] } }],
  });
  expect(admitted.facts[0]).toMatchObject({
    type: "delivery.admitted",
    data: { principal: { id: "alice", type: "user" } },
  });
  expect(admitted.inputs[0]?.answers).toEqual([
    {
      interactionId: "review",
      optionId: "approve",
      text: "Proceed.",
      deliveryId: "answer",
      responseId: "response_answer_0",
    },
  ]);
});
