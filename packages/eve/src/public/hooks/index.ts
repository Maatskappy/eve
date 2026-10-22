/**
 * Hook authoring helpers for `agent/hooks/*.ts` files.
 *
 * Hooks prepare sessions (`prewarm`) and subscribe to stream events (`events`).
 * See {@link defineHook} for the authoring shape and
 * {@link HookContext} for the runtime context every handler receives.
 */

export {
  type HookContext,
  type HookDefinition,
  type HookEvent,
  type HookEventKey,
  type HookEventMap,
  type HookEventType,
  type PrewarmContext,
  type PrewarmHook,
  type StreamEventHook,
  type StreamEventHooks,
  defineHook,
} from "#public/definitions/hook.js";
