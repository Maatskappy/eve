import { describe, expect, it, vi } from "vitest";
import { ContextContainer } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import type { EnsuredSandboxAccess } from "#execution/sandbox/ensure.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { SandboxState } from "#sandbox/state.js";
import { SandboxSessionGoneError } from "#shared/sandbox-session-gone-error.js";
import { withOwnerSandboxReadiness } from "./borrow-readiness.js";
import { requestSandboxReadiness } from "./request-readiness.js";

vi.mock("./request-readiness.js", () => ({ requestSandboxReadiness: vi.fn() }));

describe("borrowed sandbox readiness", () => {
  it("requests fresh owner readiness instead of recreating a disappeared sandbox", async () => {
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, "session-1");
    const sandbox = mockSandbox();
    const oldState: SandboxState = {
      session: { instanceId: "old", providerName: "test", state: null, stateProtocolVersion: 1 },
    };
    const newState: SandboxState = {
      session: { instanceId: "new", providerName: "test", state: null, stateProtocolVersion: 1 },
    };
    vi.mocked(requestSandboxReadiness)
      .mockResolvedValueOnce(oldState)
      .mockResolvedValueOnce(newState);
    const access = (get: EnsuredSandboxAccess["get"]): EnsuredSandboxAccess => ({
      get,
      captureState: async () => newState,
      detach: async () => undefined,
      end: async () => {},
      stop: async () => {},
    });
    const initialGet = vi.fn(async () => sandbox.session);
    const resume = vi
      .fn()
      .mockResolvedValueOnce(
        access(async () => {
          throw new SandboxSessionGoneError("Gone after acknowledgement");
        }),
      )
      .mockResolvedValueOnce(access(async () => sandbox.session));
    const borrowed = withOwnerSandboxReadiness({
      ctx,
      ownerSessionId: "session-1",
      access: access(initialGet),
      resume,
    });

    expect(await borrowed.get()).toBe(sandbox.session);
    expect(initialGet).not.toHaveBeenCalled();
    expect(resume.mock.calls.map(([state]) => state)).toEqual([oldState, newState]);
    expect(requestSandboxReadiness).toHaveBeenCalledTimes(2);
    expect(await borrowed.get()).toBe(sandbox.session);
    expect(requestSandboxReadiness).toHaveBeenCalledTimes(2);
  });
});
