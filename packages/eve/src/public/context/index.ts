/**
 * Runtime context helpers for authored code.
 *
 * These APIs work only inside active authored runtime execution such as
 * tools and other eve-invoked callbacks.
 *
 * @example
 * ```ts
 * import { defineState } from "eve/context";
 * ```
 */

export type {
  SessionAuth,
  SessionAuthContext,
  SessionParent,
  SessionPredecessor,
  SessionTurn,
} from "#context/accessors.js";
export { defineState, type StateHandle, type StateOptions } from "#public/definitions/state.js";
export { setCallbackData } from "#public/definitions/callback-data.js";
export type { SessionContext, SessionInfo, SessionSchedule } from "#context/session-context.js";
export type { HistoryMessage } from "#shared/history-message.js";
