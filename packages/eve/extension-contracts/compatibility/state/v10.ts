import {
  defineState,
  setCallbackData,
  type SessionContext,
} from "../../../src/public/context/index.ts";

const receipts = defineState("compat.receipts", () => ({ total: 0 }));
export function reportCompletedTurn(ctx: SessionContext) {
  receipts.update((value) => ({ total: value.total + 1 }));
  setCallbackData({ sessionId: ctx.session.id, total: receipts.get().total });
}
