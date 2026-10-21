import { defineTool } from "eve/tools";

import { shellQuote } from "#shared/shell-quote.js";

import { selfModificationSourceRoot } from "../../../../paths.js";

const replacementSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    oldText: {
      type: "string",
      minLength: 1,
      description:
        "Unique exact text from the current file. Encode control characters, quotes, and backslashes as JSON escapes.",
    },
    newText: {
      type: "string",
      description:
        "Exact replacement text. Encode control characters, quotes, and backslashes as JSON escapes.",
    },
  },
  required: ["oldText", "newText"],
} as const;

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "Absolute path below the authored agent directory to edit.",
    },
    edits: {
      type: "array",
      minItems: 1,
      items: replacementSchema,
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    },
  },
  required: ["path", "edits"],
} as const;

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    replacements: { type: "integer", minimum: 1 },
  },
  required: ["path", "replacements"],
} as const;

interface ExactEdit {
  readonly oldText: string;
  readonly newText: string;
}

/** Applies unique, non-overlapping replacements matched against the original content. */
export function applyExactEdits(content: string, edits: readonly ExactEdit[]): string {
  if (edits.length === 0) {
    throw new Error("edits must contain at least one replacement.");
  }

  const matches = edits.map((edit, index) => {
    if (edit.oldText.length === 0) {
      throw new Error(`edits[${index}].oldText must not be empty.`);
    }

    const start = content.indexOf(edit.oldText);
    if (start === -1) {
      throw new Error(
        `edits[${index}].oldText was not found in the current file. Read the file and try again.`,
      );
    }
    if (content.indexOf(edit.oldText, start + 1) !== -1) {
      throw new Error(
        `edits[${index}].oldText occurs more than once. Include more surrounding text to make it unique.`,
      );
    }

    return { ...edit, end: start + edit.oldText.length, index, start };
  });

  const orderedMatches = [...matches].sort((left, right) => left.start - right.start);
  for (let index = 1; index < orderedMatches.length; index += 1) {
    const previous = orderedMatches[index - 1];
    const current = orderedMatches[index];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      throw new Error(
        `edits[${previous.index}] and edits[${current.index}] overlap. Merge them into one edit.`,
      );
    }
  }

  return orderedMatches
    .toReversed()
    .reduce(
      (result, edit) => result.slice(0, edit.start) + edit.newText + result.slice(edit.end),
      content,
    );
}

export default defineTool({
  description:
    "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
  inputSchema,
  outputSchema,
  async execute(input, ctx) {
    const { edits, path } = input;
    if (
      typeof path !== "string" ||
      !Array.isArray(edits) ||
      edits.some(
        (edit) =>
          typeof edit !== "object" ||
          edit === null ||
          typeof edit.oldText !== "string" ||
          typeof edit.newText !== "string",
      )
    ) {
      throw new Error("path must be a string and edits must contain oldText and newText strings.");
    }

    const sandbox = await ctx.getSandbox();

    const resolved = sandbox.resolvePath(path);
    const sourceRoot = selfModificationSourceRoot(sandbox);
    if (
      !resolved.startsWith(`${sourceRoot}/`) ||
      resolved.split("/").some((part) => part === "..")
    ) {
      throw new Error(`Self-modification file edits must stay below ${sourceRoot}.`);
    }

    const content = await sandbox.readTextFile({ path: resolved });

    if (content === null) {
      throw new Error(`File not found: ${path}.`);
    }
    if (content.includes("\0")) {
      throw new Error(`File "${path}" contains NUL bytes and appears to be binary.`);
    }
    // A symlink below the source root can point anywhere; the deployed root is itself a link.
    const real = await sandbox.run({ command: physicalPathsCommand(sourceRoot, resolved) });
    const [realRoot, realTarget] = real.stdout.trim().split("\n");
    if (real.exitCode !== 0 || !realRoot || !realTarget?.startsWith(`${realRoot}/`)) {
      throw new Error(`Self-modification file edits must stay below ${sourceRoot}.`);
    }

    await sandbox.writeTextFile({
      content: applyExactEdits(content, edits),
      path: resolved,
    });

    return { path: resolved, replacements: edits.length };
  },
});

/**
 * Prints the physical source root and target path, one per line, with POSIX
 * `cd -P` and `pwd -P` because `realpath` is missing on older macOS. A target
 * that is itself a symlink fails, since only its directory is resolved.
 */
function physicalPathsCommand(sourceRoot: string, target: string): string {
  const quoted = shellQuote(target);
  return [
    `[ ! -L ${quoted} ]`,
    `root=$(cd -P -- ${shellQuote(sourceRoot)} && pwd -P)`,
    `directory=$(cd -P -- "$(dirname -- ${quoted})" && pwd -P)`,
    `printf '%s\\n%s/%s\\n' "$root" "$directory" "$(basename -- ${quoted})"`,
  ].join(" && ");
}
