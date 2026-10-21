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
- **Skill root** comes from the command environment. The existing `$HOME`
  probe becomes `printf '%s\n%s\n' "$HOME" "${EVE_SANDBOX_SKILL_ROOT-}"`,
  cached per session. `$HOME/.agents/skills/...` paths resolve under
  `EVE_SANDBOX_SKILL_ROOT` when it is set; every other `$HOME` path resolves to
  the probed home, and skills fall back to `<workspace root>/skills` when
  neither is usable. `HostSandbox` sets
  `EVE_SANDBOX_SKILL_ROOT=.eve/sandbox-cache/host/sessions/<key>/skills/<template>`
  on every command, so eve never writes skills into the user's real `$HOME`.
  The environment travels with every command, so no session wrapper can drop
  it and fall back to the real home.

The system prompt is composed once per agent at bootstrap, before any session
or sandbox exists, and the per-session root depends on the session id. So the
static model-facing text describes the workspace root generically ("the
directory where `bash` commands start") instead of naming `/workspace`, and
the model never needs to know the absolute root up front:

- `read_file`, `write_file`, `glob`, and `grep` accept paths relative to the
  workspace root and resolve them with `sandbox.resolvePath()`, on every
  provider. Their results report the resolved absolute path.
- `glob` and `grep` default to the workspace root.
- Attachments stage under `<workspace root>/.eve/attachments`.

Skill paths stay symbolic (`$HOME/.agents/skills/<skill>/SKILL.md`); file
tools resolve that prefix to the declared skill root, and loading a skill with
package files opens the sandbox and prefixes the result with the resolved
directory so shell commands use the right path. On `HostSandbox`, a `bash`
command that expands `$HOME` itself sees the real home directory.

Rejected alternatives: announcing the root as a `context.state` message after
the first open (adds harness plumbing and still arrives after the first tool
call), and overriding `HOME` in host commands (breaks `git`, `pnpm`, and
credential lookups that the provider exists to reach).

## Exported session helper

Custom providers built on a non-shell engine previously had just-bash as the
reference. `eve/sandbox/provider` now exports `createSandboxSession(primitives)`,
which wraps the internal `buildSandboxSession`: a provider implements `spawn`,
`readFile`, `writeFile`, `removePath`, and `resolvePath`, and gets the full
`SandboxSession` (`run`, binary and text
variants, encodings, line ranges). The custom provider docs include a
just-bash-backed recipe built on it; the application installs `just-bash`
itself.

## Commands and environment

- `bash -c <command>` with `cwd` at the workspace root (or the resolved
  `workingDirectory`), in its own process group. Abort kills the group.
- eve tracks each session's process groups until no member is left, so a
  redirected background job (`server > log &`) is still reachable after its
  `bash` leader exits. The `bash` tool's launcher moves long-running commands
  into their own groups with `set -m`; host commands set
  `EVE_SANDBOX_JOB_ROOT=<session dir>/jobs`, and the tool keeps its job files
  there instead of `/tmp/.eve/jobs`. `stop()`, runtime shutdown, `delete()`,
  and session end kill the session's groups plus every job group without an
  `exit` file. Releasing a keyed tool-session handle kills only the groups and
  jobs that handle started.
- Absolute paths pass through; relative paths resolve from the workspace root.
- Commands inherit the eve process environment minus variables that eve loaded
  from `.env*` files and minus an explicit list of eve-owned names: what eve
  sets after launch (`EVE_DEV`, `EVE_EVALUATION`, `EVE_BASE_URL`, `PORT`, and
  the `EVE_DEV_`, `EVE_DEVELOPMENT_`, `EVE_EVALUATION_`, `EVE_MODEL_`, `NITRO_`,
  `WORKFLOW_` prefixes) plus the agent's model credentials
  (`AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`), which belong to the agent, not
  the workspace. Then `AI_AGENT=eve`, then per-call `env`. eve re-reads the
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
  only eve's file tools and skill loading map `$HOME/.agents/skills` to the
  session skill root.
- Sessions that share a `root` share its files and can overwrite each other.
- Attachments staged in a shared `root` accumulate under
  `<root>/.eve/attachments`; eve never deletes inside a root it does not own.
- Commands run detached in their own process group, so they outlive an eve
  process that exits without shutting down (for example after `kill -9`).
- Process group ids are reused after every member exits. eve drops a group
  when it sees it empty and skips jobs that wrote an `exit` file, but a group
  that empties between checks, or a job killed with `SIGKILL`, can leave a
  stale id that a later stop signals.
- The system prompt does not name the absolute workspace root; file tools take
  relative paths and report absolute ones.
- Fixtures that need the eve base image (Python, `/home/vercel-sandbox`) pin
  `DockerSandbox` off Vercel instead of moving to the development default.

## Breaking changes

- `eve/sandbox/just-bash` and `DefaultSandbox.environment({ justBash })` are
  removed.
- `DefaultSandbox` uses `HostSandbox` in development and evals, and fails at
  open in production without Docker or Vercel.
- Model-facing text no longer names `/workspace` unless the provider uses it.
