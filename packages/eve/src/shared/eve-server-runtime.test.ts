import { describe, expect, it } from "vitest";

import { selectNodeExecutable } from "./eve-server-runtime.js";

const BUN = "/Users/alice/.bun/bin/bun";
const BUN_NODE_SHIM = { path: "/private/tmp/bun-node-c6da4a4d3/node", target: BUN };

describe("selectNodeExecutable", () => {
  it("skips the node shim that bun --bun puts first on PATH", () => {
    expect(
      selectNodeExecutable(
        [BUN_NODE_SHIM, { path: "/usr/local/bin/node", target: "/usr/local/bin/node" }],
        BUN,
      ),
    ).toBe("/usr/local/bin/node");
  });

  it("returns the PATH entry so version-manager shims keep their name", () => {
    expect(
      selectNodeExecutable(
        [{ path: "/Users/alice/.volta/bin/node", target: "/Users/alice/.volta/bin/volta-shim" }],
        BUN,
      ),
    ).toBe("/Users/alice/.volta/bin/node");
  });

  it("finds nothing when every node on PATH is Bun", () => {
    expect(selectNodeExecutable([BUN_NODE_SHIM], BUN)).toBeUndefined();
  });
});
