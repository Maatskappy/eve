# eve benchmarks

This private workspace measures how coding agents create and modify eve projects. It uses
`@vercel/agent-eval`, Vercel Sandbox, and deterministic Vitest graders. These benchmarks do not
run in CI or as part of `pnpm test`.

## Run

The default subject is the current `main` canary. The runner resolves that moving alias once to its
immutable commit URL, then every model, treatment, and repetition uses that same artifact:

```sh
pnpm benchmark author-001-weather-tool
pnpm benchmark
pnpm benchmark author-001-weather-tool --runs 3
pnpm benchmark author-001-weather-tool --model kimi-k3
pnpm benchmark author-001-weather-tool --treatment baseline
pnpm benchmark author-001-weather-tool --dry
pnpm benchmark author-001-weather-tool --verbose
pnpm benchmark author-001-weather-tool --keep-failures
pnpm benchmark author-001-weather-tool --canary main
```

`--keep-failures` keeps a run the runner judged an infrastructure failure — a stalled turn, a
sandbox error — as the final result instead of discarding it. Use it while iterating on the
harness, when the failure itself is what you want to read.

`--canary <ref>` selects another published canary ref. The runner rejects refs without a package
artifact before it starts an eval. Local working trees, unpublished commits, and revision comparisons
are not supported by the native runner.

The runner uses agent-eval's native Gateway harnesses: OpenCode for other providers, Claude Code
for Anthropic models, and Codex for OpenAI models. Each attempt starts an isolated Vercel Sandbox,
then scaffolds the selected immutable canary with `npx` before the coding agent starts.
The starting workspace includes pinned `just-bash@3.1.0` for the local default sandbox provider.
Scaffolded workspaces must pass typecheck and build before any model inference starts.

Local runs use the `guided` treatment by default, which keeps the `AGENTS.md` and aliases generated
by `eve init`. Pass `--treatment baseline` to remove those files before the coding agent starts.

Results are written under `apps/benchmarks/results/`. Each run includes the native transcript,
grader output, summary, copied project files, and validation output. Vercel Sandbox and AI Gateway
credentials are required.

## Profile sandbox latency

Use the opt-in sandbox profiler to compare eve's actual Vercel provider with direct SDK
creation from the same prepared snapshot. No model calls or deployed-agent changes are involved.
Every run requires an explicit team and project and creates billable resources in that project.

```sh
pnpm --filter eve build:js
pnpm profile:sandbox --team team_YOUR_TEAM --project prj_YOUR_PROJECT --dry

# Set VERCEL_TOKEN or VERCEL_OIDC_TOKEN in your environment first.
pnpm profile:sandbox --team team_YOUR_TEAM --project prj_YOUR_PROJECT --samples 10
```

The defaults are two excluded warmups and ten measured samples per variant, run sequentially
with alternating variant order, using 2 vCPUs in `iad1`. Setup creates a minimal eve-prepared
template once, outside the measured samples. It does not recreate d0's authored workspace,
v's browser template, or e0's desktop template. To profile a particular prepared template, pass
`--snapshot snap_YOUR_SNAPSHOT`; the profiler never deletes a supplied snapshot.

The `eve` variant calls the current provider's `start()` implementation, including its lookup
and initialization work. The `sdk` variant calls `Sandbox.create()` directly, without those
steps. Both then run a readiness command, another command, and a file write/read round trip.
SDK acquisition is a lower-level baseline, not a semantically equivalent replacement for eve.
The run does not include workflow scheduling, selector hooks, or authored post-open setup.

Artifacts are saved under `apps/benchmarks/results/sandbox-profile/`:

- `summary.md`: min, p50, p95, and p99 for acquisition, first command, acquisition through first
  command, subsequent command, and file operations. Failures are counted separately.
- `profile.json`: configuration, source revision/dirty state, raw phase timings, HTTP paths,
  statuses, UTC start times, request IDs, and any resources left after cleanup.
- `trace.json`: Chrome/Perfetto trace events showing phases and their nested HTTP requests.
  Open the file in a local trace viewer. Artifacts can contain private resource identifiers.

HTTP durations end when response headers arrive. Operation phases include SDK processing and
body/command waits, so do not add nested HTTP durations to the enclosing phase. Use request IDs
and UTC timestamps to find the corresponding server logs/traces; this profiler does not expose
server-side provisioning stages. Request headers, query strings, bodies, and exception messages
are not written to the artifacts.

`--region` selects the sandbox region, not the client's location. A laptop run includes the
laptop's network path and is not directly comparable with hosted `iad1` measurements. Run the
same entrypoint from a controlled `iad1` Node.js host for that comparison; `clientRegion` is only
populated automatically when `VERCEL_REGION` is available. A prepared eve checkout is required
on that host. Compare revisions with `--eve-dir /path/to/other/packages/eve` after rebuilding
each checkout. Keep the snapshot, client location, CPU count, and sampling options fixed.
Small samples are useful for debugging, not stable p99 estimates.

The profiler attempts to stop/delete only sandboxes created during its run, then deletes its
own prepared snapshot. Cleanup also runs after failures, SIGINT, or SIGTERM, independently of
the cancelled measurement signal. A failed run exits nonzero and preserves its partial report.
Requests time out after 90 seconds; the run stops starting work after 30 minutes. Forced process
termination can bypass cleanup. Sandboxes have a five-minute execution timeout, but named records
and snapshots can remain: inspect `remainingSandboxes` and `remainingSnapshot` after failures.

Use `--variant eve` or `--variant sdk` for one path, `--cpus` for another resource size, and
`--out` for a new artifact directory. `pnpm profile:sandbox --help` lists all options.

## Publish canonical results

Canonical publication compares the `baseline` and `guided` treatments with the same immutable eve
canary, model, harness, cases, and graders. The configured harness reflects the provider: OpenCode
for other providers, Claude Code for Anthropic, and Codex for OpenAI. Publication requires a clean
working tree and defaults to `origin/main`:

```sh
pnpm benchmark:publish --dry
pnpm benchmark:publish
pnpm benchmark:publish --revision <commit>
pnpm benchmark:publish --models kimi-k3,gpt-6-sol-high
```

Pass `--allow-dirty` only for a local, noncanonical run. It bypasses the clean-tree check, so its
results cannot be reproduced from committed source and should not be committed as published data.

Without `--models`, publication covers the complete configured model matrix. Use `--models` to
publish or refresh selected model rows. The published suite currently includes weather-tool,
new-project, OpenAPI connection, packaged skill, conditional approval, custom channel, and digest
schedule cases. The iMessage case remains available for local runs but is excluded from the
published matrix. Each
cell runs three times. Completed cells are memoized by `@vercel/agent-eval`; pass `--force` only
when every cell should run again. A successful run writes aggregate results to
`apps/docs/lib/evals/benchmark-results.json`. The public file contains outcomes and timing, not
transcripts, generated files, command logs, or synthetic world events.

Changed and newly added cases export as unavailable until they run. The exporter does not carry an
older measurement forward as current.

## Add a case

Create the next `evals/author-NNN-*` directory with:

- `CASE.ts` for the starting point, setup, and user interaction
- `EVAL.ts` for deterministic assertions
- any case-specific support files

The runner generates the `PROMPT.md` and `package.json` files required by agent-eval. A one-turn
case can be as small as:

```ts
export default defineAuthoringCase({
  startingPoint: simpleProject,
  async interact({ send }) {
    await send("Add a weather tool to this agent.");
  },
});
```

Use `simpleProject` for the selected canary's `eve init` output and `emptyProject` for a project
the coding agent creates. Put reusable setup under `lib/setups/`. Native runs support one-turn
cases; the iMessage case remains local-only. Prefer source assertions over an LLM judge.
