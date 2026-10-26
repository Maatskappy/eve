---
title: "Compaction strategies"
description: "Replace how an agent shortens its history by exporting a strategy from compaction.ts."
---

By default eve compacts with the fixed-tail strategy: a summary of everything but the latest conversation, which stays word for word up to 20,000 tokens. See [Default harness](./default-harness). To compact differently, export a strategy from `agent/compaction.ts`.

```ts title="agent/compaction.ts"
import { defineCompaction } from "eve/compaction";

export default defineCompaction({
  shouldCompact: (args) => args.inputTokens > args.threshold,
  async compact(history) {
    return history.slice(-6);
  },
});
```

## What eve does and what the strategy does

eve measures the next request, decides when compaction can run, and owns everything around it: the `compaction.requested` and `compaction.completed` events, [memory](../memory) capture and recall, failure, and billing of the summary call. A strategy owns two decisions.

| Member                  | Decides                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `shouldCompact(args)`   | Whether the next request needs compacting, from the numbers eve measured. |
| `compact(history, ctx)` | The messages that replace `history`.                                      |

`args` holds `inputTokens`, `requestEnvelopeTokens`, `threshold`, `recentWindowSize` and `event`, the eve event that prompted the check (today only `{ type: "step.started" }`; new triggers add members). It decides automatic compaction only: a user-requested compaction runs `compact` without calling it, and `ctx.forced` is `true` there. `ctx` carries the same four numbers (no `event`), plus `forced`. `history` is the conversation without memory records; eve places recalled memory ahead of the result, so a strategy never sees or reorders it. A user message you return needs a `kind`; build one with `createCompactionUserMessage(content)` from `eve/compaction`, for example to mark a checkpoint.

`ctx` adds `summarize({ messages, system })`, which runs the compaction model and bills the session, `estimateTokens(messages)`, and, when the turn can be cancelled, an `abortSignal`. A strategy that never summarizes makes no model call.

The `modelId` on `compaction.requested` and `compaction.completed` is the id of the configured compaction model (`compaction.model`, or the agent's model when none is set), whether or not the strategy summarizes. It is not the id `summarize` resolved.

## Failure

Throw `CompactionOverLimitError` (exported from `eve/compaction`) when no history the strategy could return fits. Any thrown error fails the compaction the way a failed summary does.

## Reusing the default

`fixedTail()` from `eve/compaction` returns the default strategy, so a strategy can wrap it, for example to compact earlier than the threshold.
