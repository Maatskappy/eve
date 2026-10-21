import { describe, expect, it } from "vitest";

import {
  createDockerSandboxProvider,
  createHostSandboxProvider,
  DOCKER_PROVIDER_NAME,
  HOST_PROVIDER_NAME,
} from "#execution/sandbox/bindings/local.js";

describe("local sandbox providers", () => {
  it("use distinct stable provider names", () => {
    expect(new Set([DOCKER_PROVIDER_NAME, HOST_PROVIDER_NAME, "vercel"]).size).toBe(3);
  });

  it("construct provider implementations without probing or installing", () => {
    expect(createDockerSandboxProvider({ image: "alpine:3" })).toBeDefined();
    expect(createHostSandboxProvider({ root: "." })).toBeDefined();
  });
});
