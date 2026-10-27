import type { LanguageModel } from "ai";

import type { CompactionStrategy } from "#harness/compaction/strategy.js";
import { compactMessages } from "#harness/compaction/strategies/fixed-tail/engine.js";
import { validateHarnessModelMessages } from "#harness/messages.js";

/**
 * The default strategy: when the history nears the context window, a summary
 * of everything but the latest conversation (at most 20,000 tokens, kept word
 * for word) replaces it. `model` picks the summary model: a gateway model id or a
 * language model; the session's model by default.
 */
export function fixedTail(
  options: { readonly model?: string | LanguageModel } = {},
): CompactionStrategy {
  const { model } = options;
  return {
    async compact(history, context) {
      const messages = await compactMessages(
        [...history],
        {
          recentWindowSize: context.recentWindowSize,
          threshold: Math.max(1, context.threshold - context.requestEnvelopeTokens),
        },
        (prompt) => context.summarize({ ...prompt, model }),
        context.forced,
        Math.max(0, context.inputTokens - context.requestEnvelopeTokens),
      );
      return validateHarnessModelMessages(messages);
    },
  };
}
