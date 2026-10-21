---
"eve": minor
---

Add `HostSandbox` (`eve/sandbox/host`), which runs sandbox commands with your machine's own `bash` and tools in a per-session directory under `.eve/sandbox-cache/host`, or in an existing directory with `root`. It is not an isolation boundary. `DefaultSandbox` now selects it during `eve dev` and `eve eval`, uses Docker otherwise, and fails when the sandbox opens in production without Vercel or Docker. Local self-modification now edits your app directory through it and can run `git`, `pnpm`, and `tsc`. The just-bash provider is removed, and `eve/sandbox/provider` now exports `createSandboxSession()` for building custom providers from a few primitives.

To migrate, replace `JustBashSandbox` from `eve/sandbox/just-bash` with `HostSandbox` from `eve/sandbox/host`, or follow the just-bash custom-provider example in the sandbox docs, and remove the `justBash` option from `DefaultSandbox.environment()`. If production runs outside Vercel without Docker, select a provider explicitly in `agent/sandbox/sandbox.ts`.
