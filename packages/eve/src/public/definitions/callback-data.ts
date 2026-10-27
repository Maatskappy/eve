import { loadContext } from "#context/container.js";
import { SessionCallbackDataKey, SessionCallbackKey } from "#context/keys.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";

/**
 * Attach application data to the current turn's native completion callback.
 * Call from a terminal hook. The value commits with the turn and is delivered
 * by the existing post-turn notification step, including its transport retries.
 * This does not change model output or perform external IO.
 */
export function setCallbackData(value: JsonValue): void {
  const ctx = loadContext();
  const callback = ctx.get(SessionCallbackKey);
  if (callback === undefined) {
    throw new Error("This turn has no native completion callback.");
  }
  ctx.set(SessionCallbackDataKey, { callId: callback.callId, value: parseJsonValue(value) });
}
