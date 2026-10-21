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

`start()` is an idempotent upsert on the session id (the provider contract from
#5132): `<key>` is a hash of the session id alone, never the artifact or open
options, so repeated and concurrent starts, keyed tool sessions, sharing
subagents, and other processes on the machine all find the same directory. The
template seeds the workspace only when a start creates it; concurrent creators
copy to temporary directories and race on an atomic rename, and the losers
adopt the winner's directory. Templates live under
`.eve/sandbox-cache/host/templates/<key>` (`resources/` with the authored
files, `sandbox/` with the prepared session directory), keyed by resources,
source revision, and options, published atomically, and pruned with the other
local templates. The session directory also holds `skills/` and `jobs/` (for
the `bash` tool). Authored skills are copied from the build's resources when a
session opens on a new generation, recorded in `.eve-authored-skills.json`
beside the skill root with the template key and a digest of each `SKILL.md` it
wrote: on a rebuild eve replaces the current authored skills and removes the
ones the previous generation wrote, but only while a skill's `SKILL.md` is
missing or still matches its digest, so dynamic skills in the same directory,
including one that overrides an authored skill, stay. The session state does
not change on a rebuild, so dynamic skill files are not rewritten and must
survive in place.

Session state is `{ key, startId, version }`. Resume checks that `key` matches
what the environment derives for the session. `startId` changes on every
start, so a sandbox recreated after it was gone has a new identity and eve
rewrites the dynamic skill files it lost; `copyDirectoryAtomically` and the
fill-in copy keep symlinks verbatim, so a relative link made in `prepare` points
into the session copy, not the template. When a per-session workspace was removed
outside eve (for example with `.eve`), resume throws `SandboxSessionGoneError`
(#5117): eve clears the session's sandbox state and reruns the selector, whose
`start()` seeds a fresh directory from the template, as after
`sandbox.delete()`. A missing shared `root` is a plain error that tells the
developer to create it or change `root`, because eve never creates it.

`onSessionEnd(context, state | null)` derives the session directory from the
key and ignores `state`. It stops the session's commands and jobs, then removes
the directory; it is idempotent, succeeds when nothing exists, and never
touches a shared `root`, which lives outside the session directory.

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
  `EVE_SANDBOX_SKILL_ROOT=.eve/sandbox-cache/host/sessions/<key>/skills`
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
tools resolve that prefix to the declared skill root. Loading a skill with
package files prefixes the result with the resolved directory, so shell
commands use the right path, but only when that starts nothing: the session's
sandbox is already open (`SandboxAccess.peek()`), or the bound environment is
`host`, which opens cheaply and is the provider whose skill root differs from
`$HOME`. Otherwise the result is unchanged. On `HostSandbox`, a `bash`
command that expands `$HOME` itself sees the real home directory.

Rejected alternatives: announcing the root as a `context.state` message after
the first open (adds harness plumbing and still arrives after the first tool
call), and overriding `HOME` in host commands (breaks `git`, `pnpm`, and
credential lookups that the provider exists to reach).

## Sandbox backends

Custom providers on a non-shell engine previously re-implemented eve's own
contract: template hashing and atomic publish, session-key naming, the
#5132 upsert, gone resume, and `onSessionEnd`, seeding workspace files and
skills, path resolution, `AI_AGENT`, stream conversion, and no-op lifecycle
hooks. `eve/sandbox/provider` exports `defineSandboxBackend`, where the author
describes only the engine and eve owns the contract:

```ts
defineSandboxBackend<Options>({
  name: "just-bash", // [a-z0-9-]; host, docker, vercel are reserved
  workspaceRoot: "/workspace",
  open(ctx, options): Promise<{ instance; created?: boolean }>, // find-or-create
  find(ctx, options): Promise<instance | undefined>, // required unless directoryTemplate
  remove?(ctx, options): Promise<void>, // idempotent; default rm ctx.directory
  directoryTemplate?: true,
});
// instance: exec -> { stdout, stderr, exitCode } | { stdout, stderr, exited, kill },
//           readFile -> bytes | string | null, writeFile(path, bytes),
//           removePath? (default rm via exec), stop?
// ctx: key (name-safe, per app directory and session), directory (eve-owned
//      per-session dir), session.
```

`environment()` accepts the backend's options plus `prepare`. eve seeds a sandbox
only when `open` reports `created`: workspace files under `workspaceRoot`,
authored skills at the sandbox's resolved skill root, then `prepare`; on failure
it stops and removes the sandbox so a later open cannot reconnect to it
half-seeded. Seeding runs after `open` returns, so when separate eve processes
open the same new session at once, one can use the sandbox mid-seed.
This is a documented limitation of backends without `directoryTemplate`; eve
gives no completion signal to lock on, and adds no seeded marker. Every open refreshes authored skills through the marker
described under [Modes](#modes). eve injects `AI_AGENT=eve`, normalizes buffered
and streaming exec (killing streaming commands on abort), and maps `stop()` to
stop, delete, and shutdown.

Resume calls `find` and never removes anything: `ensure` deduplicates starts,
not resumes, so a stale resume that removed on `undefined` could delete the
sandbox a concurrent resume had just started. When `find` returns `undefined`,
eve throws `SandboxSessionGoneError`. For a `directoryTemplate` backend, the
next start copies the template when `ctx.directory` is missing, and copies back
only the missing entries when the directory exists but `find` reports it
unusable (a host session whose workspace alone was deleted).
Without `find`, only a `directoryTemplate` backend can resume: it reopens a
template copy while `ctx.directory` exists, so no resume path returns an
unseeded sandbox. A state whose key differs from the current one, because the
app moved, is also gone. `defineSandboxProvider` stays for full control such as
remote sandboxes, snapshots, and network policies, and `SandboxSessionGoneError`
stays exported for those providers.

`directoryTemplate` is the one opt-in for directory-backed engines: eve seeds
and prepares a template directory once per build and copies it
(copy-on-write where supported) into `ctx.directory` before the first open.
Without it, `prepare` would run per session, a regression for `HostSandbox`
and the former just-bash provider, which both cached it per template. The
template key covers the workspace and skill resources and the `sandbox.ts`
revision, not the options: hashing arbitrary option objects breaks on cycles
and misses functions. The revision hashes only `sandbox.ts`, so edits to files it
imports need the template directory cleared; hashing the bundled sandbox module
instead would close that gap.

Backends are for engines on the machine running eve. Docker bakes resources
into its template image and Vercel into a snapshot, but a backend without
`directoryTemplate` seeds new sandboxes from the build's files under
`.eve/sandbox-cache/<name>/`, and `ctx.key` includes the app's absolute path
so VM and container names stay unique per app. Carrying resources into the
runtime would lift that limit at the cost of core changes; the docs state
"build and run on the same machine" instead.

`HostSandbox` is built from two internal backend definitions over the same
core: per-session mode uses `directoryTemplate` and reports a missing
workspace as gone; shared-root mode has no template, so eve writes no
workspace files into the author's directory, and its `find` rejects with the
plain missing-root error. It uses internal-only extensions: a workspace root
derived from the session, the app root for `.env` filtering, keyed
tool-session support, and a per-instance `dispose` for releasing a keyed call.
Process groups, job kills, env filtering, `EVE_SANDBOX_SKILL_ROOT`, and
`EVE_SANDBOX_JOB_ROOT` stay in the host instance. On Windows its `prepare` is a
no-op and opening fails with the WSL/Docker message. The just-bash guide's
backend runs in the `agent-tools-sandbox` e2e fixture, behind a subagent with
its own sandbox, so CI exercises it.

## Commands and environment

- `bash -c <command>` with `cwd` at the workspace root (or the resolved
  `workingDirectory`), in its own process group. Abort kills the group.
- eve tracks each session's process groups until no member is left, so a
  redirected background job (`server > log &`) is still reachable after its
  `bash` leader exits. The `bash` tool's launcher moves long-running commands
  into their own groups with `set -m`; host commands set
  `EVE_SANDBOX_JOB_ROOT=<session dir>/jobs`, and the tool keeps its job files
  there instead of `/tmp/.eve/jobs`. The record format lives in
  `execution/sandbox/job-records.ts`; the launcher keeps a finished command's
  record (minus its output files), because processes the command started in the
  background stay in its group. `stop()`, runtime shutdown, `delete()`, and
  session end kill the session's groups, claim and kill every job without an
  `exit` file, and kill what finished jobs left behind. Releasing a keyed
  tool-session handle kills only the groups and jobs that handle started; jobs
  match by the launcher pid the tool records, against every command the handle
  ever launched.
- Absolute paths pass through; relative paths resolve from the workspace root.
- Commands inherit the eve process environment minus variables that eve loaded
  from `.env*` files and minus an explicit list of eve-owned names: what eve
  sets after launch (`EVE_DEV`, `EVE_EVALUATION`, `EVE_BASE_URL`, `PORT`, and
  the `EVE_DEV_`, `EVE_DEVELOPMENT_`, `EVE_EVALUATION_`, `EVE_MODEL_`, `NITRO_`,
  `WORKFLOW_` prefixes) plus the agent's model credentials
  (every key in `internal/model-auth/key-env.ts` plus `VERCEL_OIDC_TOKEN`),
  which belong to the agent, not the workspace. Then `AI_AGENT=eve`, then per-call `env`. eve re-reads the
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
and auto-install scenario. The `/sandbox/just-bash` docs route stays as a
guide to building a just-bash provider instead of describing a built-in. `SandboxProviderHost.loadOptionalPackage` stays because it is
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
- Process group ids are reused after every member exits. Once a group's
  leader has exited, eve signals it only while members remain and no process
  holds the leader's pid (a pid is never reused while its group exists), and it
  prunes tracked groups that fail that check on every spawn. It ignores job
  records written before the current boot, and writes `exit` (`137`) for every
  running job it kills. A running job killed outside eve (for example `kill -9`
  by the model) whose id is reused before the next stop in the same boot can
  still be signalled.
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
