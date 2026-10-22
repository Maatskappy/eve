import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "vitest";
import { runPnpmCommand } from "#internal/testing/run-pnpm-command.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const temporary = useTemporaryDirectories();
const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const frameworkRequires = ["next", "nuxt"].map((name) =>
  createRequire(join(root, "apps/frameworks", name, "package.json")),
);
const manifest = JSON.parse(await readFile(join(root, "packages/eve/package.json"), "utf8")) as {
  exports: Record<string, string | { types?: string }>;
};

// Framework and adapter entries typecheck with their documented integration
// peers. The remaining entries must compile without those optional packages.
const integrations: Record<string, readonly string[]> = {
  "eve/react": ["react", "@types/react"],
  "eve/vue": ["vue"],
  "eve/svelte": ["svelte"],
  "eve/sveltekit": ["vite"],
  "eve/tanstack": ["vite"],
  "eve/next": [
    "next",
    "react",
    "react-dom",
    "@types/react",
    "@types/react-dom",
    "@opentelemetry/api",
  ],
  "eve/nuxt": ["nuxt", "@nuxt/kit", "@nuxt/schema", "vue", "vite"],
  "eve/channels/chat-sdk": ["chat"],
  "eve/channels/linq": ["chat", "@linqapp/sdk"],
  "eve/channels/photon": ["chat"],
  "eve/sandbox/just-bash": ["just-bash"],
  "eve/instrumentation/otel": ["@opentelemetry/api"],
};
const entries = Object.entries(manifest.exports)
  .filter(
    ([name, value]) =>
      !name.startsWith("./internal") && typeof value === "object" && value.types?.endsWith(".d.ts"),
  )
  .map(([name]) => (name === "." ? "eve" : `eve${name.slice(1)}`));
for (const entry of Object.keys(integrations))
  if (!entries.includes(entry)) throw new Error(`Stale peer matrix entry: ${entry}`);
const groups = [
  {
    name: "core",
    entries: entries.filter((entry) => !Object.hasOwn(integrations, entry)),
    peers: [] as readonly string[],
  },
  ...Object.entries(integrations)
    .filter(([entry]) => entries.includes(entry))
    .map(([entry, peers]) => ({ name: entry, entries: [entry], peers })),
];

function version(name: string): string {
  for (const resolver of [require, ...frameworkRequires]) {
    const paths = [
      ...(resolver.resolve.paths(name) ?? []),
      join(root, "node_modules/.pnpm/node_modules"),
    ];
    for (const path of paths) {
      try {
        return (
          JSON.parse(readFileSync(join(path, name, "package.json"), "utf8")) as { version: string }
        ).version;
      } catch {
        /* Try the owning workspace package. */
      }
    }
  }
  throw new Error(
    `Missing installed test prerequisite ${name}; keep the peer matrix aligned with the workspace.`,
  );
}

describe("packed public declarations", () => {
  it.each(groups)(
    "typechecks $name with strict library checks and no workspace links",
    async (group) => {
      const app = await temporary("eve-packed-public-types-");
      const tarball = process.env.EVE_SCENARIO_EVE_TARBALL_PATH;
      if (!tarball) throw new Error("Scenario setup did not pack eve.");
      const dependencies = Object.fromEntries(
        ["ai", "zod", "@types/node", "@types/json-schema", ...group.peers].map((name) => [
          name,
          version(name),
        ]),
      );
      await writeFile(
        join(app, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          dependencies: { eve: `file:${tarball}`, ...dependencies },
        }),
      );
      await writeFile(join(app, "pnpm-workspace.yaml"), "autoInstallPeers: false\n");
      await runPnpmCommand({
        args: ["install", "--ignore-scripts", "--config.minimum-release-age=0"],
        cwd: app,
      });
      await writeFile(
        join(app, "consumer.ts"),
        group.entries
          .map((entry, index) =>
            entry === "eve/workflow-modules"
              ? `import "eve/workflow-modules";`
              : `import type * as Entry${index} from ${JSON.stringify(entry)};`,
          )
          .join("\n"),
      );
      await writeFile(
        join(app, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            skipLibCheck: false,
            noEmit: true,
            types: ["node"],
            target: "ES2024",
            module: "NodeNext",
            lib: ["ES2024", "DOM", "DOM.Iterable"],
          },
          include: ["consumer.ts"],
        }),
      );
      try {
        await execute(
          process.execPath,
          [join(root, "node_modules/typescript/bin/tsc"), "-p", app],
          { maxBuffer: 2 * 1024 * 1024 },
        );
      } catch (error) {
        throw new Error(
          `${group.name} (${group.entries.join(", ")}):\n${(error as { stdout?: string }).stdout ?? String(error)}`,
          { cause: error },
        );
      }
    },
    180_000,
  );
});
