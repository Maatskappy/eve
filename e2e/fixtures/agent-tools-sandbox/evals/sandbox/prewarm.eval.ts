import { defineEval } from "eve/evals";

const MARKER = "/workspace/prewarm-session.txt";

export default defineEval({
  description: "Sandbox preparation survives message-free creation and runs only once per session.",
  async test(t) {
    const message =
      "Alice is opening a prepared analysis workspace. " +
      `Run the bash command \`cat ${MARKER} && printf %s updated > ${MARKER}\` ` +
      "and reply with the contents you read.";
    for (const messageFree of [true, false]) {
      const first = messageFree ? await (await t.session()).send(message) : await t.send(message);
      first.expectOk();
      t.calledTool("bash", { output: new RegExp(first.sessionId, "u") });

      const second = await first.session.send(
        `Alice returns to the same workspace. Run the bash command \`cat ${MARKER}\` ` +
          "and reply with the file contents verbatim.",
      );
      second.expectOk();
      t.calledTool("bash", { output: /updated/u });
    }
  },
});
