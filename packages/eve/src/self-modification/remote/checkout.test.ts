import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executeGitHubShell, installCodeTooling } = vi.hoisted(() => ({
  executeGitHubShell: vi.fn(),
  installCodeTooling: vi.fn(),
}));
vi.mock("#extensions/git/extension/lib/github-shell.js", () => ({ executeGitHubShell }));
vi.mock("#extensions/code/extension/lib/sandbox.js", () => ({
  CODE_TOOLING_REVALIDATION_KEY: "eve-code-tooling:test",
  installCodeTooling,
}));
vi.mock("./github.js", () => ({
  deployedGitHubConfig: () => ({
    broker: vi.fn(),
    connector: "github/agent-author",
    org: "acme",
  }),
}));
const deployed = {
  authorize: () => true,
  baseBranch: "main",
  directory: "apps/weather",
  github: { connector: "github/agent-author", repository: "acme/agents" },
};

import type { SandboxSession } from "#shared/sandbox-session.js";

import {
  createDeployedSelfModificationEnvironment,
  defineDeployedSelfModificationSandbox,
  initializeDeployedCheckout,
  prepareDeployedSelfModificationSandbox,
} from "./checkout.js";

describe("deployed checkout initialization", () => {
  const run = vi.fn();
  const sandbox = {
    resolvePath: (path: string) => `/workspace/${path}`,
    run,
    removePath: vi.fn(),
    readFile: vi.fn(),
    readBinaryFile: vi.fn(),
    readTextFile: vi.fn(),
    spawn: vi.fn(),
    writeFile: vi.fn(),
    writeFiles: vi.fn(),
    writeBinaryFile: vi.fn(),
    writeTextFile: vi.fn(),
  } as SandboxSession;

  beforeEach(() => {
    vi.clearAllMocks();
    executeGitHubShell.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    run.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
  });

  it("clones through the scoped credential lease before creating and validating the checkout", async () => {
    await initializeDeployedCheckout(sandbox, deployed, "child-1");

    expect(executeGitHubShell).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "gh repo clone 'acme/agents' repository -- --branch 'main' --single-branch",
        permissions: [{ access: "write", provider: "github", repositories: ["acme/agents"] }],
      }),
      expect.objectContaining({ connector: "github/agent-author", org: "acme" }),
      expect.objectContaining({ sessionId: "child-1" }),
    );
    const getSandbox = executeGitHubShell.mock.calls[0]![2].getSandbox;
    expect(await getSandbox()).toBe(sandbox);
    expect(run).toHaveBeenCalledOnce();
    const command = run.mock.calls[0]![0].command as string;
    expect(command).toContain("remote set-url origin 'https://github.com/acme/agents.git'");
    expect(command).toContain("git -C '/workspace/repository' switch -c 'eve/selfmod-");
    expect(command).toContain("realpath -e -- '/workspace/repository/apps/weather/agent'");
    expect(command).toContain('case "$agent" in "$root"/*)');
  });

  it("stops before touching a checkout when authentication or clone fails", async () => {
    executeGitHubShell.mockResolvedValue({
      exitCode: 128,
      stderr: "Repository not found",
      stdout: "",
    });
    await expect(initializeDeployedCheckout(sandbox, deployed, "child-1")).rejects.toThrow(
      "Could not check out configured repository acme/agents (exit 128).",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an invalid application or agent directory", async () => {
    run.mockResolvedValue({ exitCode: 2, stderr: "", stdout: "" });
    await expect(initializeDeployedCheckout(sandbox, deployed, "child-1")).rejects.toThrow(
      "verify the configured application directory and agent/ exist inside the checkout",
    );
  });
});

describe("deployed self-modification sandbox", () => {
  it("uses Vercel Sandbox only when deployed on Vercel", () => {
    expect(createDeployedSelfModificationEnvironment(() => true)?.provider).toBe("vercel");
    expect(createDeployedSelfModificationEnvironment(() => false)).toBeUndefined();
  });

  const savedDev = process.env.EVE_DEV;
  afterEach(() => {
    if (savedDev === undefined) delete process.env.EVE_DEV;
    else process.env.EVE_DEV = savedDev;
  });

  it("defers the Vercel requirement until the sandbox opens off Vercel", async () => {
    delete process.env.EVE_DEV;
    const selector = defineDeployedSelfModificationSandbox(deployed, () => false);
    await expect(selector({ session: { id: "child-1" } } as never)).rejects.toThrow(
      "Deployed self-modification requires deploying on Vercel",
    );
  });

  it("stays inert during eve dev without probing the host", async () => {
    process.env.EVE_DEV = "1";
    const onVercel = vi.fn(() => true);
    const selector = defineDeployedSelfModificationSandbox(deployed, onVercel);
    await expect(selector({ session: { id: "child-1" } } as never)).rejects.toThrow(
      "unavailable during eve dev",
    );
    expect(onVercel).not.toHaveBeenCalled();
  });

  it("prepares reusable CLI tooling without checkout contents or credentials", async () => {
    const commands: string[] = [];
    const sandbox = {
      resolvePath: (path: string) => `/workspace/${path}`,
      run: async ({ command }: { command: string }) => {
        commands.push(command);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      writeTextFile: async () => {},
    };
    await prepareDeployedSelfModificationSandbox(sandbox);

    // The sandbox user cannot write root-owned /usr/local/bin, where corepack shims go.
    expect(commands[0]).not.toContain("corepack");
    expect(commands[0]).not.toContain("nodejs");
    expect(commands.join("\n")).not.toContain("GITHUB_TOKEN");
    expect(installCodeTooling).toHaveBeenCalledWith(sandbox);
  });

  it("reports command output when tooling preparation fails", async () => {
    await expect(
      prepareDeployedSelfModificationSandbox({
        resolvePath: (path) => `/workspace/${path}`,
        run: async () => ({
          exitCode: 1,
          stderr: "eve requires rg in the deployed sandbox",
          stdout: "",
        }),
        writeTextFile: async () => {},
      }),
    ).rejects.toThrow("eve requires rg in the deployed sandbox");
  });
});
