import { Buffer } from "node:buffer";

import type { ContextContainer } from "#context/container.js";
import {
  DynamicSkillManifestKey,
  DynamicSkillSandboxKey,
  type DynamicSkillManifest,
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
    async get() {
      if (preparing !== undefined) return await preparing;
      const pending = (async () => {
        const sandbox = await access.get();
        if (sandbox === null) return null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const manifest = ctx.get(DynamicSkillManifestKey);
          await synchronize(ctx, access, sandbox, manifest);
          if (manifest === ctx.get(DynamicSkillManifestKey)) return sandbox;
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
  const desired = new Map(
    Object.values(manifest ?? {})
      .flat()
      .filter((skill) => skill.files !== undefined)
      .map((skill) => [skill.name, skill]),
  );
  const written = { ...ctx.get(DynamicSkillSandboxKey) };
  if (desired.size === 0 && Object.keys(written).length === 0) return;
  const state = await access.captureState();
  const identity = state.session === null ? null : JSON.stringify(state.session);

  for (const [name, marker] of Object.entries(written)) {
    if (desired.has(name)) continue;
    if (identity !== null && marker.startsWith(`${identity}#`)) {
      await removeSkillPackageFromSandbox({ name, sandbox });
    }
    delete written[name];
    ctx.set(DynamicSkillSandboxKey, { ...written });
  }
  for (const skill of desired.values()) {
    const marker = `${identity}#${skill.revision}`;
    if (identity !== null && written[skill.name] === marker) continue;
    // A failed replacement must never be mistaken for a fully installed package.
    delete written[skill.name];
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
