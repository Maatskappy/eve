import { encodeLineBytes } from "#protocol/session-events/envelope.js";
import { callbackDelivered, callbackDeliveredAfterEnd } from "#harness/session-machine/runs.js";
import { commitSessionStep, type SessionStepState } from "#execution/publish-session-events.js";
import type { SessionStateTransition } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("execution.callback-receipt");

/**
 * Publishes the receipt for an acknowledged completion callback on a session that goes on.
 * Its own step, so a failed stream write retries without repeating the acknowledged request.
 */
export async function emitCallbackDeliveredStep(
  input: SessionStepState & { readonly callId: string },
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, (target) =>
    commitSessionStep(target, (view) => [callbackDelivered(view, target.callId)], {
      origin: "own",
    }),
  );
}

/**
 * Writes the receipt after the session's end, on the stream its finalization kept open. The
 * session's tables are closed by then, so the line is written as it is and never folded.
 */
export async function emitTerminalCallbackDeliveredStep(input: {
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly callId: string;
}): Promise<void> {
  "use step";
  try {
    const writer = input.sessionWritable.getWriter();
    try {
      await writer.write(
        encodeLineBytes({
          at: new Date().toISOString(),
          facts: [callbackDeliveredAfterEnd(input.callId)],
        }),
      );
    } finally {
      writer.releaseLock();
    }
  } catch (error) {
    // The callback is acknowledged and the session has ended. A stream that can't take the
    // receipt, such as one a turn already closed, must not fail the session's finalization.
    log.warn("failed to write the callback receipt", { callId: input.callId, error });
  }
}
