import { shellQuote } from "./shell.ts";

export const GIT_READ_SUBCOMMANDS = [
  "blame",
  "diff",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
] as const;

export const MAX_GIT_OUTPUT_BYTES = 64 * 1024;

const EXIT_MARKER = "eve-git-exit:";

/**
 * The shell command for one read-only git invocation in `root`. `head` cuts output at
 * the source so an unbounded `git log -p` stops early; git's exit code travels on
 * stderr because the pipe would otherwise hide it.
 */
export function gitReadCommand(root: string, args: readonly string[]): string {
  const [subcommand, ...rest] = args;
  if (!GIT_READ_SUBCOMMANDS.some((allowed) => allowed === subcommand)) {
    throw new Error(
      `git ${subcommand ?? ""} is not available; use one of: ${GIT_READ_SUBCOMMANDS.join(", ")}`,
    );
  }
  const writer = rest.find((arg) => /^--output(?:=|$)/u.test(arg));
  if (writer !== undefined) {
    throw new Error(`${writer} is not available because it writes a file; read stdout instead`);
  }
  // Optional locks would let `status` and `diff` rewrite the index the caller is staging.
  const git = `GIT_OPTIONAL_LOCKS=0 git --no-pager -C ${shellQuote(root)} ${args.map(shellQuote).join(" ")}`;
  return `{ ${git}; echo "${EXIT_MARKER}$?" >&2; } | head -c ${MAX_GIT_OUTPUT_BYTES + 1}`;
}

/** Splits git's exit code back out of stderr and reports whether stdout hit the cap. */
export function gitReadResult(result: { stdout: string; stderr: string }): {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
} {
  const marker = result.stderr.lastIndexOf(EXIT_MARKER);
  const bytes = Buffer.from(result.stdout, "utf8");
  const truncated = bytes.length > MAX_GIT_OUTPUT_BYTES;
  return {
    exitCode: marker === -1 ? 1 : Number(result.stderr.slice(marker + EXIT_MARKER.length)),
    stdout: truncated ? bytes.subarray(0, MAX_GIT_OUTPUT_BYTES).toString("utf8") : result.stdout,
    stderr: marker === -1 ? result.stderr : result.stderr.slice(0, marker),
    truncated,
  };
}
