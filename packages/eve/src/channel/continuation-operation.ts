import { createHash } from "node:crypto";
import type { SessionAuthContext } from "#channel/types.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";

/** Server-owned identity of an authenticated, replayable continuation. */
export interface ContinuationOperation {
  readonly id: string;
  readonly ownerKey: string;
  readonly payloadDigest: string;
}

export function continuationOperation(
  id: string,
  auth: SessionAuthContext,
  payload: unknown,
  effectiveAuth: SessionAuthContext = auth,
): ContinuationOperation {
  return {
    id,
    ownerKey: digest([invocationOwnerKey(auth), invocationOwnerKey(effectiveAuth)]),
    payloadDigest: digest(payload),
  };
}

export function operationDeliveryId(sessionId: string, operation: ContinuationOperation): string {
  return digest([sessionId, operation.ownerKey, operation.id]);
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
        return Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        );
      }),
    )
    .digest("hex");
}

export class ContinuationOperationConflictError extends Error {
  constructor() {
    super("This operationId was already accepted with a different payload.");
    this.name = "ContinuationOperationConflictError";
  }
}

/** Carries framework metadata without expanding authored channel option contracts. */
export function attachContinuationOperation<T extends object>(
  target: T,
  operation: ContinuationOperation | undefined,
): T {
  if (operation !== undefined)
    (target as T & { operation: ContinuationOperation }).operation = operation;
  return target;
}

export function readContinuationOperation(target: object): ContinuationOperation | undefined {
  return (target as { operation?: ContinuationOperation }).operation;
}
