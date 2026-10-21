import type { DockerSandboxSession } from "#public/sandbox/docker.js";
import { describe, expect, expectTypeOf, it } from "vitest";

import { defineDefaultSandboxProvider } from "#sandbox/providers/default.js";
import { DockerSandbox, HostSandbox, VercelSandbox } from "#sandbox/providers.js";
import type { RuntimeSandboxSessionFor } from "#shared/sandbox-session.js";

describe("sandbox providers", () => {
  it("implements default selection through the provider contract", () => {
    const environment = defineDefaultSandboxProvider({
      isDeployedOnVercel: () => true,
      isDockerAvailable: () => false,
    }).environment();
    expect(environment.provider).toBe("vercel");
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
