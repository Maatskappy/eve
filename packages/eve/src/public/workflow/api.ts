/**
 * Workflow run and hook operations for routes and functions marked with `"use step"`.
 *
 * eve-owned declarations keep the SDK's wider types out of eve's public API.
 */
import * as runtime from "#internal/workflow/runtime.js";

/** The lifecycle state of a workflow run. */
export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** A handle to a workflow run, from {@link start} or {@link getRun}. */
export interface WorkflowRun<T = unknown> {
  readonly runId: string;
  /** Reads the run's current status. */
  readonly status: Promise<WorkflowRunStatus>;
  /** Waits for the run to finish; rejects when it fails or is cancelled. */
  readonly returnValue: Promise<T>;
  /** Cancels the run. */
  cancel(): Promise<void>;
}

/**
 * Starts a run of a `"use workflow"` function with its arguments.
 *
 * eve routes the run to the agent's own workflow queue, so `start` takes no queue or deployment options.
 */
export const start: {
  <TArgs extends unknown[], TResult>(
    workflow: (...args: TArgs) => Promise<TResult>,
    args: TArgs,
  ): Promise<WorkflowRun<TResult>>;
  <TResult>(workflow: () => Promise<TResult>): Promise<WorkflowRun<TResult>>;
} = runtime.start;

/** Returns a handle to an existing run without reading it. */
export const getRun: <T = unknown>(runId: string) => WorkflowRun<T> = runtime.getRun;

/** A run stream's reader, which also reports the index of its last chunk. */
export interface WorkflowRunReadable<T = unknown> extends ReadableStream<T> {
  /** The index of the last chunk written, or `-1` when none has been. */
  getTailIndex(): Promise<number>;
}

/** The durable streams of one workflow run, each named by an optional namespace. */
export interface WorkflowRunStreams {
  /** Reads the run's current status. */
  readonly status: Promise<WorkflowRunStatus>;
  /** Reads a stream from `startIndex`; a negative index counts back from the tail. */
  getReadable<T = unknown>(options?: {
    readonly namespace?: string;
    readonly startIndex?: number;
  }): WorkflowRunReadable<T>;
  /**
   * Appends to a stream. A write is acknowledged once buffered: pass `ops` and await it after
   * releasing the writer to know the chunks are durable.
   */
  getWritable<T = unknown>(options?: {
    readonly namespace?: string;
    readonly ops?: Promise<unknown>[];
  }): WritableStream<T>;
}

/**
 * Returns the durable streams of an existing run. `resilientStart` waits for a run that was
 * accepted but is not yet materialized, for a caller that writes right after starting it.
 */
export function getRunStreams(
  runId: string,
  options: { readonly resilientStart?: boolean } = {},
): WorkflowRunStreams {
  return options.resilientStart === true
    ? new runtime.Run<unknown>(runId, { resilientStart: true })
    : runtime.getRun(runId);
}

/** Delivers a payload to the hook with this token; resolves once the payload is persisted. */
// The SDK also accepts hook records and key overrides and resolves the storage record; eve keeps
// tokens as the only handle and does not promise that record.
export async function resumeHook<T = unknown>(token: string, payload: T): Promise<void> {
  await runtime.resumeHook(token, payload);
}
