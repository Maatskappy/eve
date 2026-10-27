import { SessionCallbackDataKey } from "#context/keys.js";
import { isObject } from "#shared/guards.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";

/** Project only this caller's authored data from the committed turn context. */
export function callbackDataProperties(
  serializedContext: Record<string, unknown>,
  callId: string | undefined,
): { readonly applicationData?: JsonValue } {
  const data = serializedContext[SessionCallbackDataKey.name];
  return callId !== undefined && isObject(data) && data.callId === callId
    ? { applicationData: parseJsonValue(data.value) }
    : {};
}
