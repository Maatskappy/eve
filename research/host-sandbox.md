---
issue: TBD
status: draft
last_updated: "2026-10-21"
---

# Host sandbox

## Summary

Add `HostSandbox`, a sandbox provider that runs commands with the machine's real
`bash` against a real directory. Make it the `DefaultSandbox` choice during
`eve dev` and `eve eval`, move local self-modification onto it, and remove the
just-bash provider.

just-bash emulated a shell in JavaScript over a virtual filesystem. It ran no
real binaries (`git`, `pnpm`, `tsc`, `python`), so local agents behaved
differently from deployed ones, and self-modification needed a custom mounted
filesystem to reach the app's source. On a developer's machine those binaries
already exist. `HostSandbox` uses them directly.

`HostSandbox` is **not** an isolation boundary. Commands run as the user that
started eve, with that user's filesystem, network, and credentials.

## Authoring API

```ts
import { HostSandbox } from "eve/sandbox/host";

// A fresh directory per session, seeded from agent/sandbox/workspace and prepare.
export default defineSandbox(() => HostSandbox.environment().open());

HostSandbox.environment({
  async prepare(sandbox) {
    await sandbox.run({ command: "git init -q" });
  },
});

// A shared, existing directory, resolved from the app root.
HostSandbox.environment({ root: "." });
```

`root` and `prepare` are mutually exclusive at the type level. `HostSandbox`
has no open options and no `setNetworkPolicy`.

## Modes

|                | Per-session (default)                              | Shared `root`                                |
| -------------- | -------------------------------------------------- | -------------------------------------------- |
| Workspace root | `.eve/sandbox-cache/host/sessions/<key>/workspace` | `resolve(appRoot, root)`                     |
| Seeded from    | cached template: workspace files, then `prepare`   | nothing; eve never writes seed files into it |
| Deleted by eve | on `delete()` and session end                      | never                                        |

`<key>` is a hash of the durable session id, so keyed tool sessions and resume
find the same directory. Templates live under
`.eve/sandbox-cache/host/templates/<key>`, keyed by resources and source
revision, published atomically, and pruned with the other local templates.

Session state is `{ root, version }`. Resume checks that `root` matches what the
environment derives for the session and that it still exists.

## Workspace and skill root contract

Today `/workspace` is a hard invariant: the prompt, tool descriptions, error
messages, attachment staging, and skill fallback all name it. A host directory
cannot be `/workspace`, so both roots become provider-declared:

- **Workspace root** is what `sandbox.resolvePath(".")` returns. Every provider
  already implements `resolvePath` by anchoring relative paths at its root;
  Vercel and Docker keep `/workspace`.
- **Skill root** is optional `skillRoot` on the session primitives. When
  absent, eve keeps the `$HOME/.agents/skills` probe (with the
  `<workspace root>/skills` fallback). `HostSandbox` declares
  `.eve/sandbox-cache/host/sessions/<key>/skills`, so eve never writes skills
  into the user's real `$HOME`.

The system prompt is composed once per agent at bootstrap, before any session
or sandbox exists, and the per-session root depends on the session id. So the
static model-facing text describes the workspace root generically ("the
directory where `bash` commands start") instead of naming `/workspace`, and
every runtime surface renders the real root from the opened session:

- `glob` and `grep` default to the session's workspace root.
- The absolute-path error names an example under the real root.
- Attachments stage under `<workspace root>/.eve/attachments`.

The model learns the absolute root from its first `bash`, `glob`, or `grep`
call. Skill paths stay symbolic (`$HOME/.agents/skills/<skill>/SKILL.md`); file
tools resolve that prefix to the declared skill root. On `HostSandbox`, a
`bash` command that expands `$HOME` itself sees the real home directory.

Rejected alternatives: announcing the root as a `context.state` message after
the first open (adds harness plumbing and still arrives after the first tool
call), and overriding `HOME` in host commands (breaks `git`, `pnpm`, and
credential lookups that the provider exists to reach).

## Exported session helper

Custom providers built on a non-shell engine previously had just-bash as the
reference. `eve/sandbox/provider` now exports `createSandboxSession(primitives)`,
which wraps the internal `buildSandboxSession`: a provider implements `spawn`,
`readFile`, `writeFile`, `removePath`, `resolvePath`, and optionally
`skillRoot`, and gets the full `SandboxSession` (`run`, binary and text
variants, encodings, line ranges). The custom provider docs include a
just-bash-backed recipe built on it; the application installs `just-bash`
itself.

## Commands and environment

- `bash -c <command>` with `cwd` at the workspace root (or the resolved
  `workingDirectory`), in its own process group. Abort kills the group.
  `stop()`, runtime shutdown, `delete()`, and releasing a keyed tool-session
  handle kill the handle's live process groups.
- Absolute paths pass through; relative paths resolve from the workspace root.
- Commands inherit the eve process environment minus variables that eve loaded
  from `.env*` files, then `AI_AGENT=eve`, then per-call `env`. eve re-reads the
  development env files at spawn and drops each key whose current value equals
  the file value. This stays correct across env-file reloads and across the
  dev server's process boundary without new state. A shell-exported variable
  with a different value is kept.

## DefaultSandbox selection

1. Vercel Sandbox when deployed on Vercel.
2. `HostSandbox` (per-session, with `prepare`) when `EVE_DEV=1`, which
   `eve dev` and `eve eval` without `--url` set.
3. Docker when a daemon is reachable.
4. Otherwise an environment whose preparation is a no-op and whose open throws
   an actionable error naming Docker, Vercel Sandbox, and explicit
   `HostSandbox`. Builds still succeed on any host.

`HostSandbox` is never a silent production default. The `justBash` option is
removed; there is no `host` option because `root` conflicts with the shared
`prepare` and is only meaningful when chosen explicitly.

## Self-modification

Local self-modification binds `HostSandbox.environment({ root: "." })` during
`eve dev`. In development the sandbox app root is the authored app root, not the
runtime generation snapshot, so the workspace root is the developer's real
project. Outside dev it binds the default Vercel environment with a selector
that throws, the same prewarm-safe approach remote self-modification uses.
Remote self-modification drops its dev-only just-bash branch and always binds
the Vercel environment; it keeps `/source` as its symlinked view of the
checkout.

| just-bash mount  | Host path (relative to the app root) |
| ---------------- | ------------------------------------ |
| `/source` (rw)   | `agent/`                             |
| `/traces` (ro)   | `.eve/traces/v1`                     |
| `/logs` (ro)     | `.eve/logs`                          |
| `/eve-docs` (ro) | `node_modules/eve/docs`              |

Local instructions are resolved at `session.started`, so they render these as
absolute paths under the authored app root. Guidance shared with the remote
child takes the source and docs roots as arguments. `edit_file` and
`search_registry` are shared too; they read the source root from the active
child (`/source` when deployed, `resolvePath("agent")` locally), and
`edit_file` rejects paths outside it. The built-in `write_file` stays
unconstrained, as it always was; the instructions limit source edits to the
agent directory. The instructions allow real `git`, `pnpm`, and `tsc` (for
example a typecheck after edits) but keep source edits on the edit tools.
Read-only mounts become a convention instead of an enforced boundary.

## just-bash removal

Remove the bindings, provider, `eve/sandbox/just-bash` export, peer and dev
dependencies, the optional-engine bundling hooks that only existed for it, the
auto-install scenario, and the docs page (permanently redirected to
`/sandbox/host`). `SandboxProviderHost.loadOptionalPackage` stays because it is
part of the public extension contract.

## Known limitations

- A `bash` command that expands `$HOME` itself sees the real home directory;
  only eve's file tools map `$HOME/.agents/skills` to the session skill root.
- Sessions that share a `root` share its files and can overwrite each other.
- Commands run detached in their own process group, so they outlive an eve
  process that exits without shutting down (for example after `kill -9`).
- The model learns the absolute workspace root at its first sandbox call, not
  from the system prompt.
- Fixtures that hardcode `/workspace` or need the eve base image (Python,
  `/home/vercel-sandbox`) pin `DockerSandbox` off Vercel instead of moving to
  the development default.

## Breaking changes

- `eve/sandbox/just-bash` and `DefaultSandbox.environment({ justBash })` are
  removed.
- `DefaultSandbox` uses `HostSandbox` in development and evals, and fails at
  open in production without Docker or Vercel.
- Model-facing text no longer names `/workspace` unless the provider uses it.
