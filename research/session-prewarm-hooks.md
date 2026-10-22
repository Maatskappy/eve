---
issue: "User request"
status: implemented
last_updated: "2026-10-22"
---

# Lazy sandbox preparation and prewarm hooks

Dynamic skill resolution must not start a sandbox just to write supporting
files. Resolve instructions before the model call, and prepare supporting files
when code actually accesses the sandbox. An optional prewarm hook exercises that
same sandbox access path early.

## Authoring API

```ts title="agent/hooks/prepare.ts"
import { defineHook } from "eve/hooks";

export default defineHook({
  async prewarm(ctx) {
    await ctx.preload("sandbox", async (sandbox) => {
      await sandbox.run({
        abortSignal: ctx.abortSignal,
        command: "prepare-project",
      });
    });
  },
});
```

`prewarm` is a dedicated callback, not an entry in `events`. It has no stream
position, invented event, or turn. Existing stream-event hooks remain unchanged.

`PrewarmContext` exposes session identity and creation-time auth, agent identity,
an abort signal, and `preload("sandbox", callback?)`. The callback receives the
ready session sandbox; preloading resolves after that callback finishes.
Concurrent calls share sandbox acquisition but each callback runs. The initial
asset set is only `"sandbox"`; there are no speculative skill, instruction,
connection, or model preload APIs.

## Runtime behavior

```text
resolve skills → retain instructions and pending package files → model call

sandbox access → acquire/resume sandbox → synchronize packages → return sandbox

prewarm hook → the same sandbox access path, before the first turn
```

Keep existing skill definitions and model-triggered instruction loading. Skills
with supporting files no longer force compute startup. Persist pending packages
across durable steps, and deduplicate writes by package revision and sandbox
identity. Changes and removals apply on sandbox access, not while resolving the
skill catalog. A failed synchronization remains pending and retries on access;
never return a sandbox whose required packages are only partly written.

Run prewarm callbacks in discovery order after inbox ownership is established,
before the first turn or message-free wait. Creation still returns on acceptance;
messages may queue while preparation runs. Do not run dynamic resolvers, channel
delivery, session hooks, or model calls merely to prewarm. A callback therefore
cannot assume that the first message's capabilities or principal are available.

Preparation is best effort: log callback failures, preserve acquired sandbox
state, and continue normal execution. Callbacks must await their work and be safe
to retry after an interrupted durable step. Successfully checkpointed preparation
does not rerun on later turns or deployment handoff. Normal reset and expiry
cleanup also releases a sandbox prepared without any turn.

## Scope

Reuse existing sandbox ownership, persistence, initialization, and Drive/snapshot
mounting. Prepared mounts remain app-owned; do not add a visibility API, capability
system, automatic extraction of files from dynamic code, or a new storage pool.
Read-only mounts must not be treated as writable dynamic skill destinations.

This change removes sandbox I/O from model-only turns. Prewarming can additionally
move sandbox startup and app-owned setup earlier, but cannot eliminate genuinely
dynamic file work or guess future authorization. It does not make hidden skills
a filesystem security boundary.

## Validation

Cover model-only turns with packaged dynamic skills, first-access readiness,
durable-step restoration, unchanged/changed/removed packages, failed writes,
concurrent access, and sandbox recreation. Cover prewarm ordering, initial-message
and message-free creation, callback failure, reuse across turns, and cleanup before
any turn. Add fixture evals for the public hook and lazy-file golden paths, update
published docs and extension contracts, and run focused local tests before CI.
