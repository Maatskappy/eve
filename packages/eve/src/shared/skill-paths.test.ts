import { describe, expect, it } from "vitest";

import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import {
  MODEL_SKILL_ROOT,
  resolveSandboxModelPath,
  resolveSandboxSkillRoot,
} from "#shared/skill-paths.js";

const HOME_PROBE_COMMAND = `printf '%s\\n%s\\n' "$HOME" "\${EVE_SANDBOX_SKILL_ROOT-}"`;

describe("skill path helpers", () => {
  it("resolves the sandbox skill root from HOME", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
    });

    await expect(resolveSandboxSkillRoot({ sandbox: sandbox.session })).resolves.toBe(
      "/home/agent/.agents/skills",
    );
    await expect(resolveSandboxSkillRoot({ sandbox: sandbox.session })).resolves.toBe(
      "/home/agent/.agents/skills",
    );
    expect(sandbox.commandLog).toEqual([HOME_PROBE_COMMAND]);
  });

  it("expands a leading $HOME in model-supplied paths", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent/\n" },
      },
    });

    await expect(
      resolveSandboxModelPath({ path: "$HOME/notes/todo.md", sandbox: sandbox.session }),
    ).resolves.toBe("/home/agent/notes/todo.md");
    await expect(
      resolveSandboxModelPath({ path: "$HOME", sandbox: sandbox.session }),
    ).resolves.toBe("/home/agent");
    expect(sandbox.commandLog).toEqual([HOME_PROBE_COMMAND]);
  });

  it("does not treat lookalike variables or embedded $HOME as home paths", async () => {
    const sandbox = mockSandbox();

    await expect(
      resolveSandboxModelPath({ path: "$HOME_DIR/notes.md", sandbox: sandbox.session }),
    ).resolves.toBe("$HOME_DIR/notes.md");
    await expect(
      resolveSandboxModelPath({ path: "/workspace/$HOME/notes.md", sandbox: sandbox.session }),
    ).resolves.toBe("/workspace/$HOME/notes.md");
    expect(sandbox.commandLog).toEqual([]);
  });

  it("falls back to skills/ under the workspace root when HOME is unusable", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "\n" },
      },
    });

    await expect(resolveSandboxSkillRoot({ sandbox: sandbox.session })).resolves.toBe(
      "/workspace/skills",
    );
    await expect(
      resolveSandboxModelPath({
        path: `${MODEL_SKILL_ROOT}/research/references/catalog.md`,
        sandbox: sandbox.session,
      }),
    ).resolves.toBe("/workspace/skills/research/references/catalog.md");
  });

  it("resolves model-facing seed paths before writing to the sandbox", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
      },
    });

    await expect(
      resolveSandboxModelPath({
        path: `${MODEL_SKILL_ROOT}/research/references/catalog.md`,
        sandbox: sandbox.session,
      }),
    ).resolves.toBe("/home/agent/.agents/skills/research/references/catalog.md");
  });

  it("resolves skill paths to a declared skill root and other paths to HOME", async () => {
    const sandbox = mockSandbox({
      commands: {
        [HOME_PROBE_COMMAND]: {
          exitCode: 0,
          stderr: "",
          stdout: "Welcome!\n/home/agent\n/app/.eve/skills\n",
        },
      },
    });

    await expect(resolveSandboxSkillRoot({ sandbox: sandbox.session })).resolves.toBe(
      "/app/.eve/skills",
    );
    await expect(
      resolveSandboxModelPath({
        path: `${MODEL_SKILL_ROOT}/research/references/catalog.md`,
        sandbox: sandbox.session,
      }),
    ).resolves.toBe("/app/.eve/skills/research/references/catalog.md");
    await expect(
      resolveSandboxModelPath({ path: "$HOME/notes.md", sandbox: sandbox.session }),
    ).resolves.toBe("/home/agent/notes.md");
    expect(sandbox.commandLog).toEqual([HOME_PROBE_COMMAND]);
  });
});
