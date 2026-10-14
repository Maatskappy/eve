import { createDeclarationCopier } from "../_shared.mjs";

export default {
  packageName: "@linqapp/chat-sdk-adapter",
  compiledPath: "@linqapp/chat-sdk-adapter",
  copyDeclarations: createDeclarationCopier({
    // Emitted per source file, so index.d.ts imports its siblings.
    files: ({ distEntries }) =>
      distEntries
        .filter((entry) => entry.endsWith(".d.ts"))
        .map((entry) => ({ source: entry, output: entry })),
    rewrites: {
      chat: { kind: "vendored", compiledPath: "chat" },
      "@linqapp/sdk": { kind: "external" },
      standardwebhooks: { kind: "external" },
    },
  }),
};
