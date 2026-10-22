import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import {
  updateSandboxSkillContributors,
  withDynamicSkillFiles,
} from "#context/dynamic-skill-files.js";
import type { DynamicResolveContext } from "#dynamic/definition.js";
import { createSkillLoader, sessionSkills } from "#execution/catalog/skills.js";
import {
  AuthKey,
  StaticModelReferenceKey,
  DynamicSkillManifestKey,
  DynamicSkillSandboxKey,
  SessionIdKey,
  SandboxKey,
  SandboxSkillContributorsKey,
  type DynamicSkillManifest,
} from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import {
  EVE_NAMESPACE_NAMES,
  EVE_NAMESPACE_RESERVATION,
  NAMES_OUTSIDE_EVE_NAMESPACE,
} from "#internal/testing/catalog-fixtures.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { defineSkill } from "#public/definitions/skill.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import type { SandboxAccess, SandboxSessionState, SandboxState } from "#sandbox/state.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import {
  defineSandboxProvider,
  type SandboxProviderSessionContext,
} from "#shared/sandbox-provider.js";
import { SandboxSessionGoneError } from "#shared/sandbox-session-gone-error.js";
import type { SkillFileContent, SkillPackageDefinition } from "#shared/skill-definition.js";

// Sandbox start loads the prepared artifact; these tests prepare none.
vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => null),
}));

const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;
const SKILL_ROOT = "/home/agent/.agents/skills";

const contributors = vi.hoisted(() => ({ statuses: new Map<string, string>() }));
vi.mock("#internal/workflow/runtime.js", async (original) => ({
  ...(await original<typeof import("#internal/workflow/runtime.js")>()),
  getWorld: async () => ({
    runs: { get: async (id: string) => ({ status: contributors.statuses.get(id) ?? "running" }) },
  }),
}));
beforeEach(() => contributors.statuses.clear());

function createMockBundle(authoredSkillNames: readonly string[] = []): CompiledBundle {
  return {
    adapterRegistry: undefined as never,
    compiledArtifactsSource: undefined as never,
    graph: undefined as never,
    hookRegistry: undefined as never,
    moduleMap: undefined as never,
    nodeId: undefined,
    resolvedAgent: {
      config: { name: "test-agent" },
      skills: authoredSkillNames.map((name) => ({ name })),
    } as never,
    subagentRegistry: undefined as never,
    toolRegistry: undefined as never,
    turnAgent: undefined as never,
  };
}

function persistedSandbox(id: string): SandboxSessionState {
  return { providerName: "mock", state: { id }, stateProtocolVersion: 1 };
}

/**
 * A provider that, like the built-in ones, names a session's sandbox the same
 * way on every start, and whose sandbox can be removed outside eve.
 */
function recreatableSandbox() {
  const sandboxes: ReturnType<typeof mockSandbox>[] = [];
  let gone = false;
  const handle = (sandbox: ReturnType<typeof mockSandbox>) => ({
    sandbox: sandbox.session,
    onRuntimeShutdown: async () => {},
    onSandboxDelete: async () => {},
    onSandboxStop: async () => {},
  });
  const environment = defineSandboxProvider({
    name: "recreatable",
    environment: () => ({
      onSessionEnd: async () => {},
      prepare: async () => null,
      async resume() {
        if (gone) {
          gone = false;
          throw new SandboxSessionGoneError("The sandbox was removed.");
        }
        return handle(sandboxes.at(-1)!);
      },
      async start(context: SandboxProviderSessionContext) {
        const sandbox = mockSandbox({
          commands: {
            [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
          },
        });
        sandboxes.push(sandbox);
        return { handle: handle(sandbox), state: { name: `sandbox-${context.session.id}` } };
      },
    }),
  }).environment();
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition: {
        environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        revisionHash: "hash",
        selector: defineSandbox(() => environment.open()),
        sourceId: "sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
  return { registry, removeOutsideEve: () => void (gone = true), sandboxes };
}

/** Mirrors ensureSandboxAccess: the persisted state appears once the sandbox starts. */
function createCtx(authoredSkillNames: readonly string[] = []) {
  const ctx = new ContextContainer();
  const sandbox = mockSandbox({
    commands: {
      [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
    },
  });
  const state: { session: SandboxSessionState | null; next: string } = {
    next: "sandbox-1",
    session: null,
  };
  const get = vi.fn(async () => {
    state.session ??= persistedSandbox(state.next);
    return sandbox.session;
  });
  ctx.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
  ctx.set(SessionIdKey, "test-session");
  const access = withDynamicSkillFiles(ctx, {
    captureState: async () => ({ session: state.session }),
    get,
    stop: async () => {},
  });
  ctx.setVirtualContext(SandboxKey, access);
  ctx.set(BundleKey, createMockBundle(authoredSkillNames));
  return { access, ctx, get, sandbox, state };
}

function createResolver(
  slug: string,
  handler: () =>
    | SkillPackageDefinition
    | Record<string, SkillPackageDefinition>
    | null
    | Promise<SkillPackageDefinition | Record<string, SkillPackageDefinition> | null>,
  extensionNamespace?: string,
): ResolvedDynamicSkillResolver {
  return {
    eventNames: ["session.started"],
    events: {
      "session.started": handler,
    },
    exportName: "default",
    extensionNamespace,
    logicalPath: `skills/${slug}.ts`,
    slug,
    sourceId: `skills/${slug}.ts`,
    sourceKind: "module",
  };
}

function makeEvent(): UnstampedMessageStreamEvent {
  return { type: "session.started", data: {} } as UnstampedMessageStreamEvent;
}

function makeSkill(
  description: string,
  markdown = description,
  files?: Record<string, SkillFileContent>,
): SkillPackageDefinition {
  return defineSkill({ description, files, markdown });
}

async function dispatch(ctx: ContextContainer, ...resolvers: ResolvedDynamicSkillResolver[]) {
  await dispatchDynamicSkillEvent({ ctx, event: makeEvent(), messages: [], resolvers });
}

function writtenPaths(sandbox: ReturnType<typeof mockSandbox>): string[] {
  return sandbox.writes.map((write) => write.path);
}

describe("dispatchDynamicSkillEvent", () => {
  it("bounds retained package state across resolvers without committing an oversized update", async () => {
    const { ctx, get } = createCtx();
    const files = { "data.bin": new Uint8Array(6 * 1024 * 1024) };
    await dispatch(
      ctx,
      createResolver("first", () => makeSkill("First", "First", files)),
    );
    const saved = ctx.get(DynamicSkillManifestKey);
    await expect(
      dispatch(
        ctx,
        createResolver("second", () => makeSkill("Second", "Second", files)),
      ),
    ).rejects.toThrow("Dynamic skill session state exceeds 16 MiB");
    expect(ctx.get(DynamicSkillManifestKey)).toBe(saved);
    expect(get).not.toHaveBeenCalled();
  });

  it("stores SKILL.md as authored, including frontmatter", async () => {
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver("tenant", () => makeSkill("Tenant", "---\nname: tenant\n---\n# Body\n")),
    );

    expect(ctx.get(DynamicSkillManifestKey)?.tenant?.[0]?.markdown).toBe(
      "---\nname: tenant\n---\n# Body\n",
    );
  });

  it("names map entries by their bare key", async () => {
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver("custom", () => ({
        "talk-like-a-dog": makeSkill("Talk like a dog", "Woof."),
      })),
    );

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      custom: [{ description: "Talk like a dog", markdown: "Woof.", name: "talk-like-a-dog" }],
    });
  });

  it("accepts a skill name that starts with a digit", async () => {
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver("tenant", () => ({ "3d-modeling": makeSkill("Model in 3D", "Model.") })),
    );

    expect(ctx.get(DynamicSkillManifestKey)?.tenant?.map((skill) => skill.name)).toEqual([
      "3d-modeling",
    ]);
  });

  it.each(EVE_NAMESPACE_NAMES)(
    "skips a resolver that returns %s, in eve's namespace",
    async (name) => {
      const logs = captureLogRecords();
      const { ctx } = createCtx();
      await dispatch(
        ctx,
        createResolver("tenant", () => ({
          [name]: makeSkill("Reserved"),
          policy: makeSkill("Tenant policy"),
        })),
      );

      expect(ctx.get(DynamicSkillManifestKey)?.tenant).toBeUndefined();
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          fields: {
            error: expect.stringContaining(
              `Dynamic skill resolver "skills/tenant.ts" returned the reserved skill name "${name}". ${EVE_NAMESPACE_RESERVATION}; rename the skill.`,
            ),
          },
          level: "error",
        }),
      );
    },
  );

  it("keeps skills outside eve's namespace, including the built-in tools' former names", async () => {
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver("tenant", () =>
        Object.fromEntries(NAMES_OUTSIDE_EVE_NAMESPACE.map((name) => [name, makeSkill(name)])),
      ),
    );

    expect(ctx.get(DynamicSkillManifestKey)?.tenant?.map((skill) => skill.name)).toEqual(
      NAMES_OUTSIDE_EVE_NAMESPACE,
    );
  });

  it("skips a resolver that returns an illegal skill name", async () => {
    const logs = captureLogRecords();
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver("tenant", () => ({
        "release notes": makeSkill("Release notes"),
        policy: makeSkill("Tenant policy"),
      })),
      createResolver("support", () => makeSkill("Support policy")),
    );

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      support: [{ description: "Support policy", markdown: "Support policy", name: "support" }],
    });
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        fields: {
          error: expect.stringContaining(
            'Dynamic skill resolver "skills/tenant.ts" returned illegal skill name "release notes".',
          ),
        },
        level: "error",
      }),
    );
  });

  it("prefixes map entries with the mount namespace for an extension resolver", async () => {
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver(
        "crm__playbooks",
        () => ({ triage: makeSkill("Triage an account", "Triage.") }),
        "crm",
      ),
    );

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      crm__playbooks: [
        { description: "Triage an account", markdown: "Triage.", name: "crm__triage" },
      ],
    });
  });

  it("lets a dynamic skill override a same-named authored skill instead of throwing", async () => {
    const { access, ctx, sandbox } = createCtx(["talk-like-a-dog"]);
    await dispatch(
      ctx,
      createResolver("custom", () => ({
        "talk-like-a-dog": makeSkill("Dynamic override", "Woof.", { "notes.md": "Bark." }),
      })),
    );

    expect(ctx.get(DynamicSkillManifestKey)?.custom?.[0]).toMatchObject({
      description: "Dynamic override",
      markdown: "Woof.",
      name: "talk-like-a-dog",
    });
    await access.get();
    expect(writtenPaths(sandbox)).toEqual([
      `${SKILL_ROOT}/talk-like-a-dog/SKILL.md`,
      `${SKILL_ROOT}/talk-like-a-dog/notes.md`,
    ]);
  });

  it("collapses a directly-returned single defineSkill to the bare slug", async () => {
    const { ctx } = createCtx();
    await dispatch(
      ctx,
      createResolver("tenant", () => makeSkill("Tenant policy")),
    );

    expect(ctx.get(DynamicSkillManifestKey)).toEqual({
      tenant: [{ description: "Tenant policy", markdown: "Tenant policy", name: "tenant" }],
    });
  });

  it("throws and recommends manual namespacing when two resolvers emit the same name", async () => {
    const { ctx, sandbox } = createCtx();
    const alpha = createResolver("alpha", () => ({ shared: makeSkill("From alpha") }));
    const beta = createResolver("beta", () => ({ shared: makeSkill("From beta") }));

    await expect(dispatch(ctx, alpha, beta)).rejects.toThrow(
      /Dynamic skill "shared".*Namespace the map key manually/u,
    );

    expect(sandbox.writes).toEqual([]);
    expect(ctx.get(DynamicSkillManifestKey)).toBeUndefined();
  });
});

describe("dynamic skill supporting files", () => {
  it.each(["withdrawn", "relayed withdrawal", "ended"])(
    "keeps shared packages outside the catalog and cleans up only their own files (%s)",
    async (ending) => {
      const owner = createCtx();
      const child = createCtx();
      const relay = createCtx();
      const contribute = (manifest: DynamicSkillManifest) => {
        if (ending === "relayed withdrawal") {
          updateSandboxSkillContributors(relay.ctx, { child: manifest });
          updateSandboxSkillContributors(owner.ctx, relay.ctx.require(SandboxSkillContributorsKey));
        } else updateSandboxSkillContributors(owner.ctx, { child: manifest });
      };
      await dispatch(
        owner.ctx,
        createResolver("policy", () => makeSkill("Policy", "Policy", { "rules.md": "Owner" })),
      );
      await dispatch(
        child.ctx,
        createResolver("research", () =>
          makeSkill("Research", "Research", { "notes.md": "Child" }),
        ),
      );
      contribute(child.ctx.require(DynamicSkillManifestKey));
      expect([...sessionSkills(owner.ctx).keys()]).toEqual(["policy"]);
      expect(owner.get).not.toHaveBeenCalled();
      await owner.access.get();
      expect(owner.sandbox.files.get(`${SKILL_ROOT}/research/notes.md`)).toBe("Child");
      if (ending === "ended") contributors.statuses.set("child", "completed");
      else contribute({});
      await owner.access.get();
      expect(owner.sandbox.files.has(`${SKILL_ROOT}/research/notes.md`)).toBe(false);
      expect(owner.sandbox.files.get(`${SKILL_ROOT}/policy/rules.md`)).toBe("Owner");
    },
  );

  it.each([false, true])(
    "shares identical packages and rejects conflicting contributors (different: %s)",
    async (different) => {
      const owner = createCtx();
      const child = createCtx();
      await dispatch(
        owner.ctx,
        createResolver("policy", () => makeSkill("Policy", "Policy", { "rules.md": "Owner" })),
      );
      await dispatch(
        child.ctx,
        createResolver("policy", () =>
          makeSkill("Policy", "Policy", { "rules.md": different ? "Child" : "Owner" }),
        ),
      );
      const update = () =>
        updateSandboxSkillContributors(owner.ctx, {
          child: child.ctx.require(DynamicSkillManifestKey),
        });
      if (different) {
        expect(update).toThrow("conflicting package revisions");
        expect(owner.ctx.get(SandboxSkillContributorsKey)).toBeUndefined();
      } else update();
      await owner.access.get();
      expect(owner.sandbox.files.get(`${SKILL_ROOT}/policy/rules.md`)).toBe("Owner");
      expect(owner.sandbox.writes).toHaveLength(2);
    },
  );

  it.each([false, true])(
    "removes pre-upgrade installed files for a later caller (cleanup retries: %s)",
    async (retry) => {
      const first = createCtx();
      first.ctx.set(AuthKey, {
        attributes: {},
        authenticator: "test",
        principalId: "alice",
        principalType: "user",
      });
      const resolver: ResolvedDynamicSkillResolver = {
        ...createResolver("policy", () => null),
        events: {
          "session.started": (_event, context) =>
            (context as DynamicResolveContext).session.auth.current?.principalId === "alice"
              ? makeSkill("Alice's policy", "Read the reference.", {
                  "private.md": "Alice's supporting data",
                })
              : null,
        },
      };
      await dispatch(first.ctx, resolver);
      await first.access.get();
      const resumed = await deserializeContext(
        JSON.parse(
          JSON.stringify({
            [StaticModelReferenceKey.name]: first.ctx.get(StaticModelReferenceKey),
            [AuthKey.name]: {
              attributes: {},
              authenticator: "test",
              principalId: "bob",
              principalType: "user",
            },
            [DynamicSkillManifestKey.name]: first.ctx.get(DynamicSkillManifestKey),
            [DynamicSkillSandboxKey.name]: { policy: JSON.stringify(first.state.session) },
          }),
        ),
      );
      const access = withDynamicSkillFiles(resumed, {
        captureState: async () => ({ session: first.state.session }),
        get: async () => first.sandbox.session,
        stop: async () => {},
      });
      resumed.set(SandboxKey, access);
      await dispatch(resumed, resolver);
      if (retry) {
        vi.spyOn(first.sandbox.session, "removePath").mockRejectedValueOnce(
          new Error("cleanup interrupted"),
        );
        await expect(access.get()).rejects.toThrow("cleanup interrupted");
        expect(resumed.get(DynamicSkillSandboxKey)?.policy).toBe(
          `${JSON.stringify(first.state.session)}#`,
        );
      }
      const sandbox = await access.get();

      expect(await sandbox?.readTextFile({ path: `${SKILL_ROOT}/policy/private.md` })).toBeNull();
      expect(resumed.get(DynamicSkillSandboxKey)).toEqual({});
    },
  );

  it("serves packaged instructions without a sandbox and synchronizes concurrent first access once", async () => {
    const { access, ctx, get, sandbox } = createCtx();
    const resolver = createResolver("policy", () =>
      makeSkill("Policy", "# Policy", { "references/rules.md": "Rules" }),
    );

    await dispatch(ctx, resolver);

    expect(get).not.toHaveBeenCalled();
    expect(sandbox.writes).toEqual([]);
    const loader = createSkillLoader(sessionSkills(ctx));
    expect(
      await loader.execute?.({ name: "policy" }, { toolCallId: "load-policy", messages: [] }),
    ).toBe("# Policy");
    expect(get).not.toHaveBeenCalled();

    await Promise.all([access.get(), access.get()]);
    expect(get).toHaveBeenCalledOnce();
    expect(writtenPaths(sandbox)).toEqual([
      `${SKILL_ROOT}/policy/SKILL.md`,
      `${SKILL_ROOT}/policy/references/rules.md`,
    ]);
    expect(ctx.get(DynamicSkillManifestKey)?.policy?.[0]?.revision).toMatch(/^[0-9a-f]{64}$/u);

    await dispatch(ctx, resolver);
    await access.get();

    expect(sandbox.writes).toHaveLength(2);
  });

  it.each([false, true])(
    "restores package bytes across durable steps (already installed: %s)",
    async (installed) => {
      const first = createCtx();
      const resolver = createResolver("policy", () =>
        makeSkill("Policy", "# Policy", {
          "rules.md": "Rules",
          "data.bin": Uint8Array.of(0, 128, 255),
        }),
      );
      await dispatch(first.ctx, resolver);
      if (installed) await first.access.get();

      const resumed = await deserializeContext(
        JSON.parse(
          JSON.stringify({
            [DynamicSkillManifestKey.name]: first.ctx.get(DynamicSkillManifestKey),
            [DynamicSkillSandboxKey.name]: first.ctx.get(DynamicSkillSandboxKey),
          }),
        ),
      );
      const get = vi.fn(async () => first.sandbox.session);
      resumed.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
      const access = withDynamicSkillFiles(resumed, {
        captureState: async () => ({ session: first.state.session }),
        get: async () => {
          first.state.session ??= persistedSandbox("sandbox-1");
          return await get();
        },
        stop: async () => {},
      });
      resumed.set(SandboxKey, access);
      await access.get();

      expect(first.sandbox.writes).toHaveLength(3);
      expect(first.sandbox.files.get(`${SKILL_ROOT}/policy/rules.md`)).toBe("Rules");
      expect(first.sandbox.fileBytes.get(`${SKILL_ROOT}/policy/data.bin`)).toEqual(
        Buffer.from([0, 128, 255]),
      );
    },
  );

  it("replaces a changed package so omitted files disappear", async () => {
    const { access, ctx, sandbox } = createCtx();
    let files: Record<string, string> = { "a.md": "A", "b.md": "B" };
    const resolver = createResolver("policy", () => makeSkill("Policy", "# Policy", files));

    await dispatch(ctx, resolver);
    await access.get();
    files = { "a.md": "A2" };
    await dispatch(ctx, resolver);
    expect(sandbox.files.get(`${SKILL_ROOT}/policy/a.md`)).toBe("A");
    await access.get();

    expect(sandbox.removedPaths).toEqual([`${SKILL_ROOT}/policy`, `${SKILL_ROOT}/policy`]);
    expect(sandbox.files.get(`${SKILL_ROOT}/policy/a.md`)).toBe("A2");
    expect(sandbox.files.has(`${SKILL_ROOT}/policy/b.md`)).toBe(false);
  });

  it("rewrites unchanged packages for a different sandbox or after the sandbox is deleted", async () => {
    const { access, ctx, sandbox, state } = createCtx();
    const resolver = createResolver("policy", () =>
      makeSkill("Policy", "# Policy", { "rules.md": "Rules" }),
    );

    await dispatch(ctx, resolver);
    await access.get();
    state.session = persistedSandbox("sandbox-2");
    await access.get();
    expect(sandbox.writes).toHaveLength(4);
    ctx.delete(DynamicSkillSandboxKey);
    await access.get();
    expect(sandbox.writes).toHaveLength(6);
  });

  it("restores packages on first access after recreation under the same provider key", async () => {
    const { registry, removeOutsideEve, sandboxes } = recreatableSandbox();
    const ctx = new ContextContainer();
    ctx.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
    ctx.set(SessionIdKey, "session-1");
    ctx.set(BundleKey, createMockBundle());
    const handler = () => makeSkill("Policy", "# Policy", { "rules.md": "Rules" });
    const resolver: ResolvedDynamicSkillResolver = {
      ...createResolver("policy", handler),
      eventNames: ["turn.started"],
      events: { "turn.started": handler },
    };
    // Each turn resumes from the state the previous turn checkpointed.
    let state: SandboxState | null = null;
    const turn = async (work?: (access: SandboxAccess) => Promise<unknown>) => {
      const access = withDynamicSkillFiles(ctx, await ensureSandboxAccess({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        nodeId: "__root__",
        registry,
        sessionId: "session-1",
        state,
      }));
      ctx.setVirtualContext(SandboxKey, access);
      await dispatchDynamicSkillEvent({
        ctx,
        event: { data: {}, type: "turn.started" } as UnstampedMessageStreamEvent,
        messages: [],
        resolvers: [resolver],
      });
      await work?.(access);
      state = await access.captureState();
    };
    const rules = (index: number) => sandboxes[index]?.files.get(`${SKILL_ROOT}/policy/rules.md`);

    await turn(async (access) => await access.get());
    expect(rules(0)).toBe("Rules");

    // First access must restore files before returning the replacement sandbox.
    removeOutsideEve();
    await turn(async (access) => await access.get());
    expect(sandboxes).toHaveLength(2);
    expect(rules(1)).toBe("Rules");

    // Resuming keeps the identity, so nothing is written again.
    const writes = sandboxes[1]!.writes.length;
    await turn(async (access) => await access.get());
    expect(sandboxes[1]!.writes).toHaveLength(writes);
  });

  it.each([false, true])(
    "removes withdrawn files on access (previously markdown-only: %s)",
    async (markdownOnly) => {
      const { access, ctx, sandbox } = createCtx();
      let result: SkillPackageDefinition | null = makeSkill("Policy", "# Policy", { "a.md": "A" });
      const resolver = createResolver("policy", () => result);
      await dispatch(ctx, resolver);
      await access.get();
      if (markdownOnly) {
        result = makeSkill("Policy", "# Inline policy");
        await dispatch(ctx, resolver);
        await access.get();
        expect(sandbox.files.get(`${SKILL_ROOT}/policy/a.md`)).toBe("A");
        expect(sandbox.removedPaths).toEqual([`${SKILL_ROOT}/policy`]);
      }
      result = null;
      await dispatch(ctx, resolver);
      expect(sandbox.files.has(`${SKILL_ROOT}/policy/a.md`)).toBe(true);
      await access.get();
      expect(sandbox.removedPaths).toEqual([`${SKILL_ROOT}/policy`, `${SKILL_ROOT}/policy`]);
      expect(sandbox.files.has(`${SKILL_ROOT}/policy/a.md`)).toBe(false);
      expect(ctx.get(DynamicSkillSandboxKey)).toEqual({});
    },
  );

  it("does not remove withdrawn files from a sandbox that never received them", async () => {
    const { access, ctx, get, sandbox, state } = createCtx();
    let enabled = true;
    const resolver = createResolver("policy", () =>
      enabled ? makeSkill("Policy", "# Policy", { "a.md": "A" }) : null,
    );

    await dispatch(ctx, resolver);
    await access.get();
    state.session = persistedSandbox("replacement");
    enabled = false;
    await dispatch(ctx, resolver);
    await access.get();

    expect(get).toHaveBeenCalledTimes(2);
    expect(sandbox.removedPaths).toEqual([`${SKILL_ROOT}/policy`]);
  });

  it.each([
    ["remove", "retry"],
    ["write", "retry"],
    ["remove", "withdraw"],
    ["write", "withdraw"],
  ])("retains cleanup ownership after a failed %s followed by %s", async (failure, next) => {
    const { access, ctx, sandbox } = createCtx();
    let content = "A";
    let enabled = true;
    const resolver = createResolver("policy", () =>
      enabled ? makeSkill("Policy", "# Policy", { "a.md": content }) : null,
    );
    await dispatch(ctx, resolver);
    await access.get();

    content = "B";
    await dispatch(ctx, resolver);
    if (failure === "remove")
      vi.spyOn(sandbox.session, "removePath").mockRejectedValueOnce(new Error("interrupted"));
    else {
      const write = sandbox.session.writeBinaryFile.bind(sandbox.session);
      vi.spyOn(sandbox.session, "writeBinaryFile").mockImplementationOnce(async (input) => {
        await write(input);
        throw new Error("interrupted");
      });
    }
    await expect(access.get()).rejects.toThrow("interrupted");

    if (next === "withdraw") {
      enabled = false;
      await dispatch(ctx, resolver);
    }
    await access.get();
    if (next === "withdraw") {
      expect(sandbox.files.has(`${SKILL_ROOT}/policy/a.md`)).toBe(false);
      expect(sandbox.files.has(`${SKILL_ROOT}/policy/SKILL.md`)).toBe(false);
      expect(ctx.get(DynamicSkillSandboxKey)).toEqual({});
    } else expect(sandbox.files.get(`${SKILL_ROOT}/policy/a.md`)).toBe("B");
  });
});
