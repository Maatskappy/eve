import { Buffer } from "node:buffer";
import type { ModelMessage } from "ai";

import { SKILL_NAME_PATTERN, SKILL_NAME_RULE } from "#discover/grammar.js";
import { ALLOWED_DYNAMIC_SKILL_EVENTS } from "#dynamic/definition.js";
import { isBrandedSkillEntry, type SkillPackageDefinition } from "#shared/skill-definition.js";
import {
  type MaterializableSkillPackage,
  normalizeSkillPackage,
  skillPackageRevision,
} from "#shared/skill-package.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { eveNamespaceReservation } from "#protocol/runtime-tools.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ContextContainer } from "#context/container.js";
import { type DurableDynamicSkillMetadata, DynamicSkillManifestKey } from "#context/keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";

const log = createLogger("dynamic-skills");

// ---------------------------------------------------------------------------
// Name qualification
// ---------------------------------------------------------------------------

function qualifyDynamicSkillNames(
  resolver: ResolvedDynamicSkillResolver,
  isSingle: boolean,
  entries: Readonly<Record<string, SkillPackageDefinition>>,
): Array<{ name: string; entry: SkillPackageDefinition }> {
  // A single returned defineSkill is named after the file slug (already
  // namespaced for an extension). A map names each entry by its bare key,
  // prefixed with the mount namespace for an extension resolver.
  const prefix =
    resolver.extensionNamespace !== undefined ? `${resolver.extensionNamespace}__` : "";
  const named = Object.entries(entries).map(([key, entry]) => ({
    entry,
    name: isSingle ? resolver.slug : `${prefix}${key}`,
  }));
  for (const { name } of named) {
    const reservation = eveNamespaceReservation(name);
    if (reservation !== undefined) {
      throw new Error(
        `Dynamic skill resolver "${resolver.logicalPath}" returned the reserved skill name "${name}". ${reservation}; rename the skill.`,
      );
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new Error(
        `Dynamic skill resolver "${resolver.logicalPath}" returned illegal skill name "${name}". ${SKILL_NAME_RULE}`,
      );
    }
  }
  return named;
}

interface DynamicSkillUpdate {
  readonly resolver: ResolvedDynamicSkillResolver;
  readonly skills: readonly MaterializableSkillPackage[];
}

interface DynamicSkillResolution {
  readonly resolver: ResolvedDynamicSkillResolver;
  readonly named: readonly { name: string; entry: SkillPackageDefinition }[];
}

function toDurableSkill(skill: MaterializableSkillPackage): DurableDynamicSkillMetadata {
  return {
    deferred: skill.deferred === true ? true : undefined,
    description: skill.description,
    markdown: skill.markdown,
    name: skill.name,
    ...(skill.files.length > 1
      ? {
          files: Object.fromEntries(
            skill.files
              .filter((file) => file.relativePath !== "SKILL.md")
              .map((file) => [file.relativePath, file.content.toString("base64")]),
          ),
          revision: skillPackageRevision(skill),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatches a stream event to dynamic skill resolvers. On a matching
 * event: runs handlers and stores instructions and package files in durable
 * context. Supporting files are materialized only when the sandbox is accessed.
 */
export async function dispatchDynamicSkillEvent(input: {
  readonly ctx: ContextContainer;
  readonly resolvers: readonly ResolvedDynamicSkillResolver[];
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const { ctx, resolvers, event, messages } = input;
  if (!ALLOWED_DYNAMIC_SKILL_EVENTS.has(event.type)) return;

  const matching = resolvers.filter((r) => r.eventNames.includes(event.type));
  if (matching.length === 0) return;

  const resolveCtx = buildResolveContext(ctx, messages);
  const manifest = ctx.get(DynamicSkillManifestKey) ?? {};
  const updates: DynamicSkillUpdate[] = [];

  const outcomes = await Promise.allSettled(
    matching.map(async (resolver) => {
      const handler = resolver.events[event.type];
      if (handler === undefined) return null;

      const rawResult = await handler(event, resolveCtx);
      if (rawResult === null || rawResult === undefined) return { resolver, named: [] };

      let entries: Record<string, SkillPackageDefinition>;
      let isSingle: boolean;
      if (isBrandedSkillEntry(rawResult)) {
        entries = { _single: rawResult as SkillPackageDefinition };
        isSingle = true;
      } else {
        entries = rawResult as Record<string, SkillPackageDefinition>;
        isSingle = false;
      }

      const named = qualifyDynamicSkillNames(resolver, isSingle, entries);
      return { resolver, named } satisfies DynamicSkillResolution;
    }),
  );

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      log.error(`Dynamic skill resolver (${event.type}) threw — skipping.`, {
        error: toErrorMessage(outcome.reason),
      });
      continue;
    }
    if (outcome.value === null) continue;
    updates.push({
      resolver: outcome.value.resolver,
      skills: outcome.value.named.map(({ name, entry }) =>
        normalizeSkillPackage({ ...entry, name }),
      ),
    });
  }

  if (updates.length === 0) return;

  const newManifest = { ...manifest };
  for (const { resolver, skills } of updates) {
    if (skills.length === 0) {
      delete newManifest[resolver.slug];
      continue;
    }
    newManifest[resolver.slug] = skills.map(toDurableSkill);
  }

  // A dynamic skill whose name matches an authored skill overrides it:
  // loading prefers the dynamic body, and supporting files replace the
  // authored package at the same sandbox path. Two dynamic resolvers
  // emitting the same name is a genuine ambiguity and still throws.
  const dynamicSkillOwners = new Map<string, string>();
  for (const [resolverSlug, skills] of Object.entries(newManifest)) {
    for (const { name } of skills) {
      const previousOwner = dynamicSkillOwners.get(name);
      if (previousOwner !== undefined) {
        throw new Error(
          `Dynamic skill "${name}" from resolver "${resolverSlug}" collides with dynamic resolver "${previousOwner}". Namespace the map key manually, e.g. "${resolverSlug}__${name}".`,
        );
      }
      dynamicSkillOwners.set(name, resolverSlug);
    }
  }

  if (Buffer.byteLength(JSON.stringify(newManifest)) > 16 * 1024 * 1024) {
    throw new Error(
      "Dynamic skill session state exceeds 16 MiB after file encoding. Reduce dynamic packages or put larger files in a sandbox snapshot or Drive.",
    );
  }
  ctx.set(DynamicSkillManifestKey, newManifest);
}
