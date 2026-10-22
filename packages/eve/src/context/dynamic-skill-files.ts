import { Buffer } from "node:buffer";
import { WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { mapWithConcurrency } from "#shared/map-with-concurrency.js";

import type { ContextContainer } from "#context/container.js";
import {
  DynamicSkillManifestKey,
  DynamicSkillSandboxKey,
  SandboxSkillContributorsKey,
  type DynamicSkillManifest,
  type DurableDynamicSkillMetadata,
} from "#context/keys.js";
import type { SandboxAccess } from "#sandbox/state.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import {
  normalizeSkillPackage,
  removeSkillPackageFromSandbox,
  writeSkillPackageToSandbox,
} from "#shared/skill-package.js";

/** Makes package synchronization part of sandbox readiness, not skill resolution. */
export function withDynamicSkillFiles<Access extends SandboxAccess>(
  ctx: ContextContainer,
  access: Access,
): Access {
  let preparing: Promise<SandboxSession | null> | undefined;
  return {
    ...access,
    async get(abortSignal) {
      if (preparing !== undefined) return await preparing;
      const pending = (async () => {
        const sandbox = await access.get(abortSignal);
        if (sandbox === null) return null;
        await pruneEndedSandboxSkillContributors(ctx);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const manifest = ctx.get(DynamicSkillManifestKey);
          const contributors = ctx.get(SandboxSkillContributorsKey);
          await synchronize(ctx, access, sandbox, manifest);
          if (
            manifest === ctx.get(DynamicSkillManifestKey) &&
            contributors === ctx.get(SandboxSkillContributorsKey)
          )
            return sandbox;
        }
        throw new Error(
          "Dynamic skills kept changing during sandbox preparation. Retry sandbox access.",
        );
      })();
      preparing = pending;
      try {
        return await pending;
      } finally {
        preparing = undefined;
      }
    },
  };
}

async function synchronize(
  ctx: ContextContainer,
  access: SandboxAccess,
  sandbox: SandboxSession,
  manifest: DynamicSkillManifest | undefined,
): Promise<void> {
  const skills = [manifest, ...Object.values(ctx.get(SandboxSkillContributorsKey) ?? {})].flatMap(
    (entry) => Object.values(entry ?? {}).flat(),
  );
  const kept = new Set(skills.map((skill) => skill.name));
  const desired = new Map(
    skills.filter((skill) => skill.files !== undefined).map((skill) => [skill.name, skill]),
  );
  assertCompatiblePackages(skills);
  const written = { ...ctx.get(DynamicSkillSandboxKey) };
  if (desired.size === 0 && Object.keys(written).length === 0) return;
  const state = await access.captureState();
  const identity = state.session === null ? null : JSON.stringify(state.session);

  // Identity-only records own installed files, but cannot prove a package revision.
  for (const [name, marker] of Object.entries(written)) {
    if (identity !== null && marker === identity) written[name] = `${identity}#`;
  }
  ctx.set(DynamicSkillSandboxKey, written);

  for (const [name, marker] of Object.entries(written)) {
    // A markdown-only result may rely on files supplied by a snapshot or Drive.
    if (kept.has(name)) continue;
    if (identity !== null && marker.startsWith(`${identity}#`)) {
      await removeSkillPackageFromSandbox({ name, sandbox });
    }
    delete written[name];
    ctx.set(DynamicSkillSandboxKey, { ...written });
  }
  for (const skill of desired.values()) {
    const marker = `${identity}#${skill.revision}`;
    if (identity !== null && written[skill.name] === marker) continue;
    // An interrupted replacement still owns files, but proves no installed revision.
    if (identity !== null) written[skill.name] = `${identity}#`;
    ctx.set(DynamicSkillSandboxKey, { ...written });
    await removeSkillPackageFromSandbox({ name: skill.name, sandbox });
    await writeSkillPackageToSandbox({
      sandbox,
      skill: normalizeSkillPackage({
        ...skill,
        files: Object.fromEntries(
          Object.entries(skill.files ?? {}).map(([path, content]) => [
            path,
            Buffer.from(content, "base64"),
          ]),
        ),
      }),
    });
    if (identity !== null) written[skill.name] = marker;
    ctx.set(DynamicSkillSandboxKey, { ...written });
  }
}

/** Registers shared packages only after checking they cannot replace another contributor's files. */
export function updateSandboxSkillContributors(
  ctx: ContextContainer,
  incoming: Readonly<Record<string, DynamicSkillManifest>>,
): void {
  const contributors = { ...ctx.get(SandboxSkillContributorsKey), ...incoming };
  // Empty manifests carry withdrawals through sharing ancestors until the session ends.
  if (
    Object.keys(contributors).length > 256 ||
    Buffer.byteLength(JSON.stringify(contributors)) > 16 * 1024 * 1024
  ) {
    throw new Error(
      "Shared sandbox skills exceed 256 contributing sessions or 16 MiB of package state. Use an independent sandbox or reduce the packages.",
    );
  }
  assertCompatiblePackages(
    [ctx.get(DynamicSkillManifestKey), ...Object.values(contributors)].flatMap((entry) =>
      Object.values(entry ?? {}).flat(),
    ),
  );
  ctx.set(SandboxSkillContributorsKey, contributors);
}

/** Ended shared sessions cannot keep another caller's withdrawn packages alive. */
export async function pruneEndedSandboxSkillContributors(ctx: ContextContainer): Promise<void> {
  const entries = Object.entries(ctx.get(SandboxSkillContributorsKey) ?? {});
  if (entries.length === 0) return;
  const world = await getWorld();
  const active = await mapWithConcurrency(entries, 16, async (entry) => {
    try {
      const run = await world.runs.get(entry[0], { resolveData: "none" });
      return run.status === "pending" || run.status === "running" ? entry : undefined;
    } catch (error) {
      if (WorkflowRunNotFoundError.is(error)) return undefined;
      throw error;
    }
  });
  const kept = active.filter((entry) => entry !== undefined);
  if (kept.length !== entries.length)
    ctx.set(SandboxSkillContributorsKey, Object.fromEntries(kept));
}

function assertCompatiblePackages(skills: readonly DurableDynamicSkillMetadata[]): void {
  const revisions = new Map<string, string>();
  for (const skill of skills) {
    if (skill.files === undefined || skill.revision === undefined) continue;
    const previous = revisions.get(skill.name);
    if (previous !== undefined && previous !== skill.revision) {
      throw new Error(
        `Shared sandbox skill "${skill.name}" has conflicting package revisions. Use distinct skill names.`,
      );
    }
    revisions.set(skill.name, skill.revision);
  }
}
