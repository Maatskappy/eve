import { Client } from "eve/client";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { delivery as deliveryState, emptySessionView, foldEvents } from "eve/events";

export default defineEval({
  description: "Alice can stop observing a request, read it again, and obtain its settled result.",
  tags: ["client", "regression"],
  async test(t) {
    const managed = await t.session();
    const host = `https://${crypto.randomUUID()}.invalid`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.origin === host
        ? t.target.fetch(`${url.pathname}${url.search}`, init)
        : originalFetch(input, init);
    };
    try {
      const session = new Client({ baseUrl: host }).sessions.attach(managed.id);
      const accepted = await session.send(
        "Alice is preparing her workday. Give her a short acknowledgement without using tools.",
        { signal: t.abortSignal },
      );
      const stopReading = new AbortController();
      const reading = accepted
        .stream({ signal: AbortSignal.any([stopReading.signal, t.abortSignal]) })
        [Symbol.asyncIterator]();
      await reading.next();
      stopReading.abort();
      let aborted = false;
      try {
        await reading.next();
      } catch (error) {
        aborted = error instanceof Error && error.name === "AbortError";
      }
      await t.require(aborted, equals(true));

      let view = emptySessionView();
      for await (const event of accepted.stream({ signal: t.abortSignal }))
        view = foldEvents(view, [event]);
      const result = await accepted.result({ signal: t.abortSignal });
      await t.require(result.status, equals("completed"));
      await t.require(result.outcome, equals("handled"));
      await t.require(result.sessionEnded, equals(false));
      await t.require(Object.hasOwn(result, "events"), equals(false));
      await t.require(deliveryState(view, accepted.deliveryId)?.status, equals("settled"));
      await t.require(Reflect.ownKeys(view).length, equals(0));
      (await managed.nextTurn()).expectOk();
      const ignored = await (
        await session.cancel({ turnId: null, signal: t.abortSignal })
      ).result({ signal: t.abortSignal });
      await t.require(ignored.status, equals("completed"));
      await t.require(ignored.outcome, equals("ignored"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});
