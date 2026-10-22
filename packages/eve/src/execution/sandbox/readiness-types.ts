import type { DynamicSkillManifest } from "#context/keys.js";
import type { SandboxState } from "#sandbox/state.js";

/** Private owner message; never accepted as a channel/session command. */
export interface SandboxReadinessRequest {
  readonly kind: "sandbox-readiness";
  readonly requesterSessionId: string;
  readonly runId: string;
  readonly namespace: string;
  readonly contributors?: Readonly<Record<string, DynamicSkillManifest>>;
}

export type SandboxReadinessReply =
  | { readonly ok: true; readonly state: SandboxState }
  | { readonly ok: false };
