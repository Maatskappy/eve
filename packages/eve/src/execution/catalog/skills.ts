/**
 * Skills in the catalog. Every skill the session can see loads through
 * `eve__skill({ name })`, deferred or not. The call resolves to one loader entry
 * whose name sits outside the tool namespace, because skills and tools have
 * separate names.
 */

import type { ContextReader } from "#context/key.js";
import { contextStorage } from "#context/container.js";
import { DynamicSkillManifestKey, SandboxKey } from "#context/keys.js";
import { opensForSkillDirectory } from "#execution/sandbox/skill-directory.js";
import { skillFilePath } from "#execution/skills/instructions.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { SEARCH_TOOL_NAME, SKILL_ENTRY_NAME } from "#protocol/catalog-tools.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { skillTarget } from "#shared/action-request-name.js";
import { stripSkillFrontmatter } from "#shared/skill-package.js";
import { MODEL_SKILL_ROOT, resolveSandboxModelPath } from "#shared/skill-paths.js";
import type { SandboxAccess } from "#sandbox/state.js";
import { toInputSchema } from "#tools/schema.js";

import { closestNames } from "./rank.js";

/** A skill the session can load. */
export interface CatalogSkill {
  readonly deferred: boolean;
  readonly description: string;
  /** The instructions loading returns. */
  readonly markdown: string;
  readonly name: string;
  /** The skill's `SKILL.md` under the skills root, when it has package files. */
  readonly path?: string;
}

/** The session's skills by name; a dynamic skill overrides a same-named authored one. */
export function sessionSkills(ctx: ContextReader | undefined): ReadonlyMap<string, CatalogSkill> {
  const skills = new Map<string, CatalogSkill>();
  for (const skill of ctx?.get(BundleKey)?.resolvedAgent.skills ?? []) {
    skills.set(skill.name, {
      deferred: skill.deferred === true,
      description: skill.description,
      markdown: skill.markdown,
      name: skill.name,
      path: skillFilePath(skill.name),
    });
  }
  for (const skill of Object.values(ctx?.get(DynamicSkillManifestKey) ?? {}).flat()) {
    skills.set(skill.name, {
      deferred: skill.deferred === true,
      description: skill.description,
      markdown: stripSkillFrontmatter(skill.markdown),
      name: skill.name,
      path: skill.revision === undefined ? undefined : skillFilePath(skill.name),
    });
  }
  return skills;
}

const SKILL_LOAD_LABEL = {
  start: (input: unknown) => `Load skill${skillName(input)}`,
  complete: (input: unknown) => `Loaded skill${skillName(input)}`,
};

function skillName(input: unknown): string {
  const skill = skillTarget(input);
  return skill === undefined ? "" : ` ${skill}`;
}

/** The entry every `eve__skill` call resolves to, with the call's own `{ name }` input. */
export function createSkillLoader(
  skills: ReadonlyMap<string, CatalogSkill>,
): HarnessToolDefinition {
  return {
    description: "Loads a skill's instructions.",
    execute: (input: { readonly name: string }) => {
      const skill = skills.get(input.name);
      // `eve__skill` validation resolves every skill before the call runs.
      if (skill === undefined) throw new Error(`No skill named "${input.name}".`);
      const access = contextStorage.getStore()?.get(SandboxKey);
      if (skill.path === undefined || access === undefined) return skill.markdown;
      return resolveSkillDirectory(access, skill.name).then((directory) =>
        directory === undefined
          ? skill.markdown
          : `Skill files: ${directory}/\n\n${skill.markdown}`,
      );
    },
    frameworkTool: true,
    inputSchema: SKILL_INPUT_SCHEMA,
    label: SKILL_LOAD_LABEL,
    name: SKILL_ENTRY_NAME,
  };
}

/**
 * Where the skill's package files live, when knowing it costs nothing extra:
 * the session's sandbox is already open, or its provider declares that it
 * opens cheaply and keeps skills outside `$HOME`. Otherwise the result stays
 * as authored; `$HOME/.agents/skills/<name>` already works there.
 */
async function resolveSkillDirectory(
  access: SandboxAccess,
  name: string,
): Promise<string | undefined> {
  const symbolic = `${MODEL_SKILL_ROOT}/${name}`;
  const open = access.peek?.() ?? null;
  if (open !== null) return await resolveSandboxModelPath({ path: symbolic, sandbox: open });
  if (access.environment === undefined || !opensForSkillDirectory(access.environment)) {
    return undefined;
  }
  try {
    const sandbox = await access.get();
    return sandbox === null
      ? undefined
      : await resolveSandboxModelPath({ path: symbolic, sandbox });
  } catch {
    // The skill still loads; the next sandbox call reports why the sandbox failed to open.
    return symbolic;
  }
}

/** Why `eve__skill` can't load `name`: the closest skills, or the connection it names. */
export function unknownSkillMessage(
  name: string,
  skills: ReadonlyMap<string, CatalogSkill>,
  connections: readonly string[],
  searchable: boolean,
): string {
  const suggestions = closestNames(name, [...skills.values()]);
  const hint =
    suggestions.length > 0
      ? ` Closest skills: ${suggestions.join(", ")}.`
      : searchable
        ? ` Find skills with ${SEARCH_TOOL_NAME}.`
        : "";
  const connection = connections.find(
    (connectionName) => connectionName.toLowerCase() === name.toLowerCase(),
  );
  const connectionHint =
    connection === undefined
      ? ""
      : ` "${connection}" is a connection, not a skill. Find its tools with ${SEARCH_TOOL_NAME}({ query: "${connection}__" }).`;
  return `No skill named "${name}".${hint}${connectionHint}`;
}

const SKILL_INPUT_SCHEMA = toInputSchema({
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
});
