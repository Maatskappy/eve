import type { QueuePrefix, World } from "#compiled/@workflow/world/index.js";

export type LocalWorld = World & {
  events: World["events"] & {
    /** Eve's local claim readback. Returned bytes have been checked against the reserved digest. */
    eveReadResumePayload(
      runId: string,
      resumeId: string,
      hookId: string,
    ): Promise<Uint8Array | undefined>;
  };
  clear(): Promise<void>;
  registerHandler(prefix: QueuePrefix, handler: (request: Request) => Promise<Response>): void;
};

export function createWorld(options?: {
  readonly baseUrl?: string;
  readonly dataDir?: string;
  readonly recoverActiveRuns?: boolean;
  readonly streamFlushIntervalMs?: number;
  readonly tag?: string;
}): LocalWorld;
