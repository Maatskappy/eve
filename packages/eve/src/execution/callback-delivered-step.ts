import { publishCallbackDelivered } from "#execution/publish-session-events.js";

/** Retry stream publication independently of the already acknowledged callback. */
export async function emitCallbackDeliveredStep(input: {
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly callId: string;
}): Promise<void> {
  "use step";
  await publishCallbackDelivered(input);
}

/** Close in a separate durable step even when the final receipt could not be written. */
export async function closeSessionStreamStep(
  sessionWritable: WritableStream<Uint8Array>,
): Promise<void> {
  "use step";
  await sessionWritable.close();
}
