import type { ModelMessage } from "ai";

import type { HarnessModelMessage } from "#harness/messages.js";

/**
 * A message a strategy returns. A user message needs a `kind`; build one with
 * `createCompactionUserMessage`.
 */
export type CompactionMessage = HarnessModelMessage;

/** The events that can prompt a compaction check, named like eve's own events. */
export type CompactionEvent = { readonly type: "step.started" };

export interface CompactionContext {
  /** Best count of the next request's input tokens, including the request envelope. */
  readonly inputTokens: number;
  /** The share of `inputTokens` that is not history: instructions, tool schemas, memory, client context. */
  readonly requestEnvelopeTokens: number;
  /** The most input tokens a request may carry before the history must be compacted. */
  readonly threshold: number;
  /** How many of the latest messages the session suggests keeping word for word. */
  readonly recentWindowSize: number;
  /** The user asked for this compaction, so `shouldCompact` was not consulted. */
  readonly forced: boolean;
  readonly abortSignal?: AbortSignal;
  /** Estimates tokens the way the core measures the history. */
  estimateTokens(messages: readonly ModelMessage[]): number;
  /** Runs the compaction model over `messages`, billed to the session. */
  summarize(input: { readonly messages: ModelMessage[]; readonly system: string }): Promise<string>;
}

/**
 * How a session's history is shortened. The core owns when compaction can
 * run, the events around it, memory records, failure and billing; a strategy
 * owns whether to compact and what the compacted history looks like.
 */
export interface CompactionStrategy {
  /**
   * Returns the replacement for `history` (the conversation, without memory
   * records, which eve places ahead of the result). Throws
   * `CompactionOverLimitError` when no history it could return fits.
   */
  compact(
    history: readonly CompactionMessage[],
    context: CompactionContext,
  ): Promise<readonly CompactionMessage[]>;
  /**
   * Decides automatic compaction from the numbers the core measured; it never
   * reads session state. `event` is the eve event that prompted the check.
   */
  shouldCompact(args: {
    /** Best count of the next request's input tokens, including the request envelope. */
    readonly inputTokens: number;
    /** The share of `inputTokens` that is not history: instructions, tool schemas, memory, client context. */
    readonly requestEnvelopeTokens: number;
    /** The most input tokens a request may carry before the history must be compacted. */
    readonly threshold: number;
    /** How many of the latest messages the session suggests keeping word for word. */
    readonly recentWindowSize: number;
    readonly event: CompactionEvent;
  }): boolean;
}
