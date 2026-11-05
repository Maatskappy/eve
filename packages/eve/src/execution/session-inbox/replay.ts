import { createHash } from "node:crypto";
import { HookNotFoundError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { World } from "#compiled/@workflow/world/index.js";
import type { LocalWorld } from "#compiled/@workflow/world-local/index.js";
import {
  dehydrateStepReturnValue,
  hydrateStepArguments,
} from "#compiled/@workflow/core/serialization.js";
import {
  getWorkflowQueueName,
  resolveRunEncryptionKey,
  getWorld,
} from "#internal/workflow/runtime.js";
import type { SessionCommand } from "#channel/types.js";
import {
  ContinuationOperationConflictError,
  operationDeliveryId,
  type ContinuationOperation,
} from "#channel/continuation-operation.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { ResumedSessionInboxHook } from "#execution/session-inbox/resume.js";
import { isObject } from "#shared/guards.js";

function ownerIndexStream(sessionId: string): string {
  return `${sessionId}_eve-continuation-owners`;
}

type SendCommand = Extract<SessionCommand, { kind: "send" }>;

/** Operation-bearing sends use the World's existing atomic hook resume claim. */
export async function resumeReplaySessionInbox(
  sessionId: string,
  command: SendCommand & { operation: ContinuationOperation },
): Promise<ResumedSessionInboxHook> {
  const world = await getWorld();
  const token = sessionInboxHookToken(sessionCommandHookToken(sessionId));
  const deliveryId = operationDeliveryId(sessionId, command.operation);
  // Resolve the owner BEFORE reading history: once a successor owns this token,
  // its predecessor cannot admit another command behind our history read.
  const hook = await world.hooks.getByToken(token).catch((error: unknown) => {
    if (HookNotFoundError.is(error)) return undefined;
    throw error;
  });
  const owners = await readReceiptOwners(world, sessionId);
  const indexed = hook === undefined || owners.has(hook.runId);
  if (hook !== undefined) owners.add(hook.runId);
  const receipt = await findReceipt(world, sessionId, command.operation, owners);
  if (receipt !== undefined) return await wakeReceipt(world, sessionId, receipt, deliveryId);
  if (hook === undefined) throw new HookNotFoundError(token);
  // Workflow spec 1 predates event admission; hook resume dedup v1 is the atomic claim contract.
  if (
    (hook.specVersion ?? 1) <= 1 ||
    !(
      world.capabilities?.hookResumeDedup === true ||
      (hook.resumeCapabilities?.hookResumeDedupVersion ?? 0) >= 1
    )
  ) {
    throw new Error("This workflow storage does not support continuation replay.");
  }
  if (command.delivery?.deliveryId !== deliveryId) {
    throw new Error("Replayable continuations require their stable delivery metadata.");
  }
  // Index before admission so an accepted command remains discoverable after
  // handoff, including sessions created by deployments predating replay.
  // Duplicate owner links are harmless; only hook_received admits a command.
  if (!indexed) await world.streams.write(sessionId, ownerIndexStream(sessionId), hook.runId);
  const run = await world.runs.get(hook.runId);
  const hookId = hook.hookId;
  const key = await resolveRunEncryptionKey(world, run);
  // The local World reserves its claim before publishing the event. Its pinned
  // adapter retains the exact bytes there, including the original encryption
  // nonce. A claim is not a receipt: validate it, then finish normal admission.
  const events = world.events as World["events"] &
    Partial<Pick<LocalWorld["events"], "eveReadResumePayload">>;
  async function readReservedPayload(): Promise<Uint8Array | undefined> {
    const reserved = await events.eveReadResumePayload?.(run.runId, deliveryId, hookId);
    if (reserved === undefined) return undefined;
    const previous: unknown = await hydrateStepArguments(reserved, run.runId, key);
    if (
      !isObject(previous) ||
      previous.kind !== "send" ||
      !isObject(previous.operation) ||
      !isObject(previous.delivery) ||
      previous.operation.id !== command.operation.id ||
      previous.operation.ownerKey !== command.operation.ownerKey ||
      previous.delivery.deliveryId !== deliveryId
    )
      throw new Error("Reserved continuation identity does not match.");
    if (previous.operation.payloadDigest !== command.operation.payloadDigest)
      throw new ContinuationOperationConflictError();
    return reserved;
  }
  let payload = await readReservedPayload();
  if (payload === undefined) {
    const ops: Promise<unknown>[] = [];
    const encoded = await dehydrateStepReturnValue(command, hook.runId, key, ops);
    await Promise.all(ops);
    if (!(encoded instanceof Uint8Array)) throw new Error("Unsupported continuation encoding.");
    payload = encoded;
  }
  async function admit(bytes: Uint8Array): Promise<void> {
    const params: {
      resumeId: string;
      resumePayloadDigest: string;
      eveRetainResumePayload?: true;
    } = {
      resumeId: deliveryId,
      resumePayloadDigest: createHash("sha256").update(bytes).digest("hex"),
    };
    // Internal local adapter option; remote Worlds receive their original API.
    if (events.eveReadResumePayload !== undefined) params.eveRetainResumePayload = true;
    await world.events.create(
      run.runId,
      {
        eventType: "hook_received",
        specVersion: run.specVersion,
        correlationId: hookId,
        eventData: { token, payload: bytes },
      },
      params,
    );
  }
  try {
    await admit(payload);
  } catch (error) {
    // Concurrent encryption produces different bytes. The atomic claim refuses
    // the loser; only the persisted command can establish semantic equality.
    const accepted = await findReceipt(world, sessionId, command.operation, owners);
    if (accepted !== undefined) return await wakeReceipt(world, sessionId, accepted, deliveryId);
    // Another local writer may have reserved without publishing yet. Converge
    // once using its validated bytes through the unchanged atomic claim path.
    const reserved = await readReservedPayload();
    if (reserved === undefined || Buffer.from(reserved).equals(payload)) throw error;
    await admit(reserved);
  }
  return await wakeReceipt(world, sessionId, hook.runId, deliveryId);
}

async function wakeReceipt(
  world: World,
  sessionId: string,
  ownerRunId: string,
  deliveryId: string,
): Promise<ResumedSessionInboxHook> {
  const run = await world.runs.get(ownerRunId);
  if (run.status === "pending" || run.status === "running") {
    // Re-publishing this existing wake also repairs a response lost between
    // durable admission and queue acceptance. Workflow replay consumes it once.
    await world.queue(
      getWorkflowQueueName(run.workflowName),
      { runId: ownerRunId },
      {
        idempotencyKey: `hook-${deliveryId}`,
        deploymentId: run.deploymentId,
        specVersion: run.specVersion,
      },
    );
  }
  return { ownerRunId, sessionId: Promise.resolve(sessionId) };
}

async function findReceipt(
  world: World,
  sessionId: string,
  operation: ContinuationOperation,
  owners: ReadonlySet<string>,
): Promise<string | undefined> {
  for (const runId of owners) {
    const run = await world.runs.get(runId).catch((error: unknown) => {
      if (WorkflowRunNotFoundError.is(error) && runId === sessionId) return undefined;
      throw error;
    });
    if (run === undefined) continue;
    const key = await resolveRunEncryptionKey(world, run);
    let cursor: string | undefined;
    do {
      const page = await world.events.list({ runId, resolveData: "all", pagination: { cursor } });
      for (const event of page.data) {
        if (event.eventType !== "hook_received") continue;
        const accepted: unknown = await hydrateStepArguments(event.eventData.payload, runId, key);
        if (!isObject(accepted) || accepted.kind !== "send" || !isObject(accepted.operation))
          continue;
        const previous = accepted.operation;
        if (previous.id !== operation.id || previous.ownerKey !== operation.ownerKey) continue;
        if (previous.payloadDigest !== operation.payloadDigest)
          throw new ContinuationOperationConflictError();
        return runId;
      }
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  }
  return undefined;
}

async function readReceiptOwners(world: World, sessionId: string): Promise<Set<string>> {
  const owners = new Set([sessionId]);
  const stream = ownerIndexStream(sessionId);
  const streams = await world.streams.list(sessionId);
  if (!streams.includes(stream)) return owners;
  let cursor: string | undefined;
  do {
    const page = await world.streams.getChunks(sessionId, stream, { cursor });
    for (const chunk of page.data) owners.add(new TextDecoder().decode(chunk.data));
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return owners;
}
