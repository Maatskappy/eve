import { defineState, type SessionContext } from "../../../src/public/context/index.ts";

const requests = defineState("compat.requests", () => ({ count: 0, lastSession: "" }));
export function recordRequest(ctx: SessionContext) {
  requests.update(value => ({ count: value.count + 1, lastSession: ctx.session.id }));
  return requests.get();
}
