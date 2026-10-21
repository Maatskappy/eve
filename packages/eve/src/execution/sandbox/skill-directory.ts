import {
  getSandboxEnvironmentRuntime,
  type SandboxEnvironmentIdentity,
} from "#shared/sandbox-environment.js";

const eagerImplementations = new WeakSet<object>();

/**
 * Marks a provider implementation whose sandbox opens cheaply and keeps skills
 * outside `$HOME`, so loading a skill may open the sandbox to report where the
 * skill's files live. Other sandboxes report it only once they are open.
 */
export function withEagerSkillDirectory<Implementation extends object>(
  implementation: Implementation,
): Implementation {
  eagerImplementations.add(implementation);
  return implementation;
}

/** Whether loading a skill may open this environment's sandbox to locate the skill's files. */
export function opensForSkillDirectory(environment: SandboxEnvironmentIdentity): boolean {
  return eagerImplementations.has(getSandboxEnvironmentRuntime(environment).implementation);
}
