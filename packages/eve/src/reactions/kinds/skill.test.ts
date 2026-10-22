import { describe, expect, it } from "vitest";

import { sessionSkills } from "#execution/catalog/skills.js";
import {
  beforeModelCall,
  evaluationError,
  reactionSession,
} from "#internal/testing/reaction-session.js";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { defineSkill } from "#public/definitions/skill.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { applyReactionEffects, evaluateValues, restoreReactions } from "../runner.js";
import { forgetSessionLive } from "../state.js";
import { dynamicSkillManifest } from "./skill.js";

/** A sandbox that records the paths written to it, under its own identity. */
function sandbox(id: string) {
  const written: string[] = [];
  const removed: string[] = [];
  const state: { id: string; generation?: string } = { id };
  return {
    access: {
      captureState: async () => ({ session: { ...state } }),
      get: async () => ({
        removePath: async ({ path }: { readonly path: string }) => {
          removed.push(path);
        },
        run: async () => ({ exitCode: 0, stderr: "", stdout: "/home/user\n" }),
        writeBinaryFile: async ({ path }: { readonly path: string }) => {
          written.push(path);
        },
      }),
      stop: async () => {},
    },
    removed,
    state,
    written,
  };
}

const policySkill = (slug: string, reference: string) => ({
  logicalPath: `skills/${slug}.ts`,
  // Each returns a skill named "policy", as a map of skills does.
  evaluate: () => ({
    policy: defineSkill({
      description: `The ${slug} policy.`,
      files: { [`references/${reference}.md`]: "Policy reference.\n" },
      content: "# Policy",
    }),
  }),
  slug,
  sourceId: `skills/${slug}.ts`,
});

/** A session whose one dynamic skill builds a supporting file, which its slot doesn't hold. */
function session(skills?: readonly object[]) {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, `session-${Math.random()}`);
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: ctx.get(SessionIdKey),
  } as never);
  ctx.set(BundleKey, {
    resolvedAgent: {
      dynamicInstructionsResolvers: [],
      dynamicSkillResolvers: skills ?? [
        {
          logicalPath: "skills/policy.ts",
          evaluate: () =>
            defineSkill({
              description: "The tenant policy.",
              files: { "references/policy.md": "Policy reference.\n" },
              content: "# Policy",
            }),
          slug: "policy",
          sourceId: "skills/policy.ts",
        },
      ],
      dynamicToolResolvers: [],
      hooks: [],
      memories: [],
    },
    subagentRegistry: { dynamicResolvers: [], preparedTools: [], subagentsByName: new Map() },
    toolRegistry: { toolsByName: new Map() },
    turnAgent: {},
  } as never);
  enterSessionProjection(ctx, undefined);
  return ctx;
}

const PACKAGE = [
  "/home/user/.agents/skills/policy/SKILL.md",
  "/home/user/.agents/skills/policy/references/policy.md",
];

describe("dynamic skill files", () => {
  it("writes a rendered file to a sandbox created later, by a process that didn't build it", async () => {
    const ctx = session();
    const first = sandbox("first");
    ctx.set(SandboxKey, first.access as never);
    await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));
    expect(first.written).toEqual(PACKAGE);

    // The same sandbox already has the package: the next step writes nothing.
    await contextStorage.run(ctx, () => applyReactionEffects(ctx));
    expect(first.written).toEqual(PACKAGE);

    // A fresh process with a new sandbox renders the skill again from its record to write it.
    forgetSessionLive(ctx.get(SessionIdKey)!);
    const next = sandbox("next");
    ctx.set(SandboxKey, next.access as never);
    await contextStorage.run(ctx, async () => {
      await restoreReactions(ctx);
      await applyReactionEffects(ctx);
    });
    expect(next.written).toEqual(PACKAGE);
  });

  it("writes the package again into a sandbox recreated under the same provider state", async () => {
    const ctx = session();
    const box = sandbox("box");
    ctx.set(SandboxKey, box.access as never);
    await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));
    expect(box.written).toEqual(PACKAGE);

    // `start()` stamps a new generation; the provider names the sandbox as before.
    box.state.generation = "recreated";
    await contextStorage.run(ctx, () => applyReactionEffects(ctx));
    expect(box.written).toEqual([...PACKAGE, ...PACKAGE]);

    await contextStorage.run(ctx, () => applyReactionEffects(ctx));
    expect(box.written).toEqual([...PACKAGE, ...PACKAGE]);
  });

  it("writes the files of the skill whose metadata the model sees when two name it", async () => {
    const ctx = session([policySkill("first", "first"), policySkill("second", "second")]);
    const box = sandbox("box");
    ctx.set(SandboxKey, box.access as never);
    await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));

    const manifest = dynamicSkillManifest(ctx);
    expect(
      Object.values(manifest)
        .flat()
        .map((skill) => skill.description),
    ).toEqual(["The first policy."]);
    expect(box.written).toEqual([
      "/home/user/.agents/skills/policy/SKILL.md",
      "/home/user/.agents/skills/policy/references/first.md",
    ]);
  });
});

const skill = (description = "The tenant policy.") =>
  defineSkill({ description, content: "# Policy" });

describe("dynamic skill names", () => {
  it.each([
    ["names one skill after its file", undefined, () => skill(), ["policy"]],
    ["names a map's skills after their keys", undefined, () => ({ "2fa": skill() }), ["2fa"]],
    [
      "prefixes an extension's map keys with its namespace",
      "tracker",
      () => ({ triage: skill() }),
      ["tracker__triage"],
    ],
  ])("%s", async (_name, extensionNamespace, evaluate, expected) => {
    const { ctx } = reactionSession({ skills: [{ evaluate, extensionNamespace, slug: "policy" }] });
    await beforeModelCall(ctx);
    expect(
      Object.values(dynamicSkillManifest(ctx))
        .flat()
        .map(({ name }) => name),
    ).toEqual(expected);
  });

  it.each([
    ["an illegal name", () => ({ "policy!": skill() }), 'illegal skill name "policy!"'],
    ["eve's namespace", () => ({ eve__policy: skill() }), 'reserved skill name "eve__policy"'],
  ])("rejects %s", async (_name, evaluate, message) => {
    const { ctx } = reactionSession({ skills: [{ evaluate, slug: "policy" }] });
    expect(await evaluationError(ctx)).toContain(message);
  });

  it("overrides an authored skill of the same name", async () => {
    const { ctx } = reactionSession({
      authoredSkills: [
        { description: "The authored policy.", content: "# Authored", name: "policy" },
      ],
      skills: [{ evaluate: () => skill("The dynamic policy."), slug: "policy" }],
    });
    await beforeModelCall(ctx);

    expect(sessionSkills(ctx).get("policy")?.description).toBe("The dynamic policy.");
  });
});

describe("dynamic skill files after a change", () => {
  it("removes a withdrawn package from the sandbox", async () => {
    let offered = true;
    const ctx = session([
      {
        evaluate: () =>
          offered
            ? defineSkill({
                description: "The tenant policy.",
                files: { "references/policy.md": "Policy reference.\n" },
                content: "# Policy",
              })
            : null,
        logicalPath: "skills/policy.ts",
        slug: "policy",
        sourceId: "skills/policy.ts",
      },
    ]);
    const box = sandbox("box");
    ctx.set(SandboxKey, box.access as never);
    await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));

    const before = box.removed.length;
    offered = false;
    await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));

    expect(box.removed.slice(before)).toEqual(["/home/user/.agents/skills/policy"]);
  });

  it("keeps a package's files until the skill is withdrawn, not when it stops returning them", async () => {
    let files = true;
    let offered = true;
    const ctx = session([
      {
        evaluate: () =>
          offered
            ? defineSkill({
                description: "The tenant policy.",
                ...(files && { files: { "references/policy.md": "Policy reference.\n" } }),
                content: "# Policy",
              })
            : null,
        logicalPath: "skills/policy.ts",
        slug: "policy",
        sourceId: "skills/policy.ts",
      },
    ]);
    const box = sandbox("box");
    ctx.set(SandboxKey, box.access as never);
    await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));

    // The sandbox may already provide the files, for example from its snapshot.
    const before = box.removed.length;
    files = false;
    await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));

    expect(box.removed.slice(before)).toEqual([]);

    offered = false;
    await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));
    expect(box.removed.slice(before)).toEqual(["/home/user/.agents/skills/policy"]);
  });

  it("doesn't remove a withdrawn package from a sandbox that never received it", async () => {
    let offered = true;
    const ctx = session([
      {
        evaluate: () =>
          offered
            ? defineSkill({
                description: "The tenant policy.",
                files: { "references/policy.md": "Policy reference.\n" },
                content: "# Policy",
              })
            : null,
        logicalPath: "skills/policy.ts",
        slug: "policy",
        sourceId: "skills/policy.ts",
      },
    ]);
    ctx.set(SandboxKey, sandbox("first").access as never);
    await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));

    const next = sandbox("next");
    ctx.set(SandboxKey, next.access as never);
    offered = false;
    await contextStorage.run(ctx, () => evaluateValues(ctx, { conversation: [] }));

    expect(next.removed).toEqual([]);
  });
});
