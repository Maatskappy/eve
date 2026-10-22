/**
 * Shared pure error projections used by public helpers and internals.
 */

import { isObject } from "#shared/guards.js";

/**
 * Projects an unknown throwable into a human-readable string.
 *
 * Plain objects are rendered as JSON rather than `"[object Object]"`.
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === null || error === undefined) {
    return String(error);
  }
  if (isObject(error)) {
    if (typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    return safeJsonStringify(error);
  }
  return String(error);
}

/**
 * Coerces an unknown throwable into a proper {@link Error} instance.
 *
 * Returns real Errors unchanged. For plain-object shapes (common after
 * structured-clone strips prototypes), copies useful `message`, `name`,
 * `stack`, and `cause` fields onto a fresh Error.
 */
export function toError(raw: unknown): Error {
  if (raw instanceof Error) {
    return raw;
  }

  const error = new Error(toErrorMessage(raw));
  if (!isObject(raw)) {
    return error;
  }

  if (typeof raw.name === "string" && raw.name.length > 0) {
    error.name = raw.name;
  }
  if (typeof raw.stack === "string" && raw.stack.length > 0) {
    error.stack = raw.stack;
  }
  if ("cause" in raw && raw.cause !== undefined && raw.cause !== raw) {
    (error as Error & { cause?: unknown }).cause = raw.cause;
  }
  return error;
}

/** Structured-clone-safe error shape that keeps the `cause` chain across IPC. */
export interface SerializedError {
  cause?: SerializedError;
  message: string;
  name: string;
  stack?: string;
}

const MAX_SERIALIZED_CAUSE_DEPTH = 8;

export function serializeError(error: unknown, depth = 0): SerializedError {
  const value = toError(error);
  const cause = (value as { cause?: unknown }).cause;
  const serialized: SerializedError = { message: value.message, name: value.name };

  if (value.stack !== undefined) {
    serialized.stack = value.stack;
  }

  if (cause !== undefined && depth < MAX_SERIALIZED_CAUSE_DEPTH) {
    serialized.cause = serializeError(cause, depth + 1);
  }

  return serialized;
}

export function deserializeError(serialized: SerializedError): Error {
  const error = toError(serialized);

  if (serialized.cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = deserializeError(serialized.cause);
  }

  return error;
}

/**
 * Yields the error itself and every object on its `cause` chain, once
 * each. Cycles terminate the walk instead of looping.
 */
export function* walkCauseChain(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let current = error;
  while (isObject(current) && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = current.cause;
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    const stringified = JSON.stringify(value);
    // `JSON.stringify` returns `undefined` for values whose top-level
    // reduces to `undefined` (functions, symbols, undefined itself).
    // Fall back so callers never receive a literal `"undefined"` that
    // they cannot tell apart from the real primitive.
    return stringified ?? String(value);
  } catch {
    return String(value);
  }
}
