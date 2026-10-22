import type { MessageStreamEvent } from "#protocol/message.js";
import type { PrewarmHook, StreamEventHook } from "../../public/definitions/hook.js";
import type { ResolvedHookDefinition } from "../types.js";

/**
 * One ordered stream-event subscriber paired with its source slug.
 *
 * `eventType` is `"*"` for wildcard subscribers, otherwise the typed
 * event name.
 */
interface RuntimeStreamEventHookEntry {
  readonly slug: string;
  readonly handler: StreamEventHook<MessageStreamEvent>;
  readonly eventType: string;
}

/**
 * Per-node runtime hook registry. Stream-event subscribers are split
 * into typed buckets (keyed by event type) and a flat wildcard bucket
 * so dispatch can iterate one typed bucket plus the wildcard bucket
 * without scanning every entry.
 */
export interface RuntimeHookRegistry {
  readonly prewarm?: readonly { readonly slug: string; readonly handler: PrewarmHook }[];
  readonly streamEventsByType: ReadonlyMap<string, readonly RuntimeStreamEventHookEntry[]>;
  readonly streamEventsWildcard: readonly RuntimeStreamEventHookEntry[];
}

/**
 * Builds the per-node runtime hook registry from an ordered list of
 * resolved hook definitions.
 *
 * The caller is responsible for sorting the input — discover-time
 * lexicographic ordering on full slug is preserved by the discovery
 * helper, so callers usually pass `resolvedHooks` directly.
 */
export function createRuntimeHookRegistry(
  resolvedHooks: readonly ResolvedHookDefinition[],
): RuntimeHookRegistry {
  const streamEventsByType = new Map<string, RuntimeStreamEventHookEntry[]>();
  const streamEventsWildcard: RuntimeStreamEventHookEntry[] = [];
  const prewarm: { readonly slug: string; readonly handler: PrewarmHook }[] = [];

  for (const hook of resolvedHooks) {
    if (hook.prewarm !== undefined) prewarm.push({ slug: hook.slug, handler: hook.prewarm });
    for (const [eventType, handler] of Object.entries(hook.events)) {
      const entry: RuntimeStreamEventHookEntry = { slug: hook.slug, handler, eventType };
      if (eventType === "*") {
        streamEventsWildcard.push(entry);
      } else {
        const bucket = streamEventsByType.get(eventType) ?? [];
        bucket.push(entry);
        streamEventsByType.set(eventType, bucket);
      }
    }
  }

  return {
    prewarm: prewarm.length === 0 ? undefined : prewarm,
    streamEventsByType,
    streamEventsWildcard,
  };
}
