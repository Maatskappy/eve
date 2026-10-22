import { defineEval } from "eve/evals";

const DYNAMIC_REFERENCE = "Dynamic policy reference fixture.";

/**
 * Skill smoke eval:
 * the dynamic tenant policy package (skills/dynamic-tenant-policy.ts) ships a
 * supporting file. Its markdown is served from session state, while the file
 * must still be written to the sandbox skill root for the model to read.
 */
export default defineEval({
  description:
    "Dynamic supporting files remain available when sandbox access happens on a later turn.",
  async test(t) {
    const first = await t.send(
      "Alice is opening a conversation. Greet her briefly without using tools.",
    );
    first.expectOk();
    await first.session.send(
      "Alice is reviewing the tenant setup. Please use the read_file tool to read " +
        "$HOME/.agents/skills/dynamic-tenant-policy/references/policy.md, then tell her what it says.",
    );

    t.succeeded();
    t.calledTool("read_file", { output: new RegExp(DYNAMIC_REFERENCE, "u") });
  },
});
