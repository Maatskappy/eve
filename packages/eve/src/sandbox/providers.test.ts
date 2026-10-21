import type { DockerSandboxSession } from "#public/sandbox/docker.js";
import { describe, expect, expectTypeOf, it } from "vitest";

import { defineDefaultSandboxProvider } from "#sandbox/providers/default.js";
import { DockerSandbox, HostSandbox, VercelSandbox } from "#sandbox/providers.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import type { RuntimeSandboxSessionFor } from "#shared/sandbox-session.js";

describe("sandbox providers", () => {
  it("selects Vercel when deployed, the host in development on POSIX, then Docker", () => {
    const select = (
      probes: { vercel: boolean; development: boolean; docker: boolean },
      posix = true,
    ) =>
      defineDefaultSandboxProvider({
        isDeployedOnVercel: () => probes.vercel,
        isDevelopment: () => probes.development,
        isDockerAvailable: () => probes.docker,
        isPosixHost: () => posix,
      }).environment().provider;

    expect(select({ vercel: true, development: true, docker: true })).toBe("vercel");
    expect(select({ vercel: false, development: true, docker: true })).toBe("host");
    expect(select({ vercel: false, development: true, docker: true }, false)).toBe("docker");
    expect(select({ vercel: false, development: false, docker: true })).toBe("docker");
  });

  it("prepares without a provider but fails to open with the available choices", async () => {
    const environment = defineDefaultSandboxProvider({
      isDeployedOnVercel: () => false,
      isDevelopment: () => false,
      isDockerAvailable: () => false,
      isPosixHost: () => true,
    }).environment();
    const { implementation } = getSandboxEnvironmentRuntime(environment);
    const context = {} as Parameters<typeof implementation.start>[0];

    await expect(implementation.prepare({} as never)).resolves.toEqual({});
    await expect(implementation.start(context, undefined, {})).rejects.toThrow(
      /Start Docker, deploy to Vercel to use Vercel Sandbox.*HostSandbox\.environment\(\)/,
    );
  });
  it("exposes image and Dockerfile constructors only for local image providers", () => {
    expect(DockerSandbox.image("example.test/agent@sha256:abc").provider).toBe("docker");
    expect(DockerSandbox.dockerfile().provider).toBe("docker");
    expect("image" in VercelSandbox).toBe(false);
    expect("dockerfile" in VercelSandbox).toBe(false);
  });

  it("makes a HostSandbox root and prepare mutually exclusive", () => {
    expect(HostSandbox.environment().provider).toBe("host");
    expect(HostSandbox.environment({ root: "." }).provider).toBe("host");
    // @ts-expect-error eve never seeds a shared root, so it cannot be prepared.
    HostSandbox.environment({ prepare: () => {}, root: "." });
  });

  it("returns runtime sandboxes from open", () => {
    const environment = DockerSandbox.environment({});
    expectTypeOf(environment.open).returns.toEqualTypeOf<
      Promise<RuntimeSandboxSessionFor<DockerSandboxSession>>
    >();
  });
});
