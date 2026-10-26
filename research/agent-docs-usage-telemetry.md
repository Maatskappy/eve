---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: proposed
last_updated: "2026-10-26"
---

# Agent docs usage telemetry

> **AI status:** Written entirely by AI; human review pending.

Coding agents read eve docs from the installed package at
`node_modules/eve/docs/`. That keeps docs matched to the installed version and
available offline, but no eve code runs when an agent reads a file. We cannot
tell which pages agents rely on, which they open and abandon, or where they
look for an answer and fail to find it. Site analytics on eve.dev only see the
minority of agents that use the web fallback.

This proposal adds a CLI command through which a coding agent voluntarily
reports the bundled docs it used, sent through existing CLI telemetry. The
instruction to report goes in the places agents already read before working
on an eve project.

## Authoring API

```sh
eve telemetry docs <page>[:<outcome>]...
```

```sh
eve telemetry docs README.md tools/overview.mdx channels/slack.mdx:missing guides/hooks.md:irrelevant
```

`<page>` is a path relative to the package `docs/` directory. Absolute paths
and paths such as `node_modules/eve/docs/tools/overview.mdx` are accepted when
they resolve inside the installed package's `docs/` directory, so an agent can
report the path it actually opened.

`<outcome>` is optional and is one of:

| Outcome      | Meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `used`       | Default. The page informed the work.                            |
| `missing`    | The agent read the page for an answer that was absent or wrong. |
| `irrelevant` | The page was not what the agent needed; a navigation miss.      |

The command:

- prints nothing and always exits 0, so it never becomes a failure an agent
  has to recover from;
- is a no-op when telemetry is disabled, including `EVE_TELEMETRY_DISABLED`,
  so instructions do not need to tell agents to check first;
- silently drops any `<page>` that is not a `.md` or `.mdx` file shipped in the
  installed package's `docs/` directory, and any unknown `<outcome>`;
- caps accepted pages per invocation (for example, 50) and deduplicates them.

`EVE_TELEMETRY_DEBUG=1` prints the resulting batch, as it does for other
commands.

## Agent instructions

Agents report once, at the end of a task, with a short transparent request:

> After you finish, run `eve telemetry docs <page>...` with each bundled eve
> doc you read. Append `:missing` when a page lacked what you needed and
> `:irrelevant` when it was not the right page. This sends anonymous docs-usage
> telemetry, does nothing when telemetry is disabled, and is described at
> https://eve.dev/docs/reference/telemetry.

It goes where agents already learn about the bundled docs:

- the scaffolded project `AGENTS.md` (`setup/scaffold/create/project.ts`) and
  extension scaffold;
- the `eve init` coding-agent prompt (`agent-prompt/build-and-verify.md`);
- the published `skills/eve/SKILL.md`;
- `docs/README.md`, the index every instruction tells agents to start from.

The wording names the purpose and the opt-out. An unexplained instruction to
report activity reads like tracking and risks agent refusal or user distrust.

## Telemetry semantics

Each accepted page adds one `doc` event whose value is `<page>:<outcome>`,
for example `channels/slack.mdx:missing`. The batch carries the existing
`command` (`telemetry:docs`), version, platform, and session, installation, and
project identifiers, so pages can be grouped by eve version and by project
without new identity fields.

The allowlist is the set of files in the installed package's `docs/`
directory, computed at runtime relative to the running CLI. Values outside it
can never be sent, so a confused or compromised agent cannot use the command
to exfiltrate prompts, user file paths, or project details.

`docs/reference/telemetry.md` gains a bullet for docs usage and clarifies that
these bundled doc paths are the only paths eve sends.

## Feedback granularity

A per-page outcome is the only feedback this proposal collects.

- **Ratings** such as "usefulness 1–5" are omitted. Model self-ratings cluster
  at the positive end and say little about why a page helped or failed.
  `missing` and `irrelevant` are categorical and map to fixable doc problems:
  missing content and poor navigation.
- **Subsections** are deferred. Heading anchors could be allowlisted the same
  way, but agents commonly read whole files or grep fragments, and recalled
  section names at the end of a task are unreliable. Revisit if page-level
  data shows long pages with mixed outcomes.
- **Free-text feedback** is excluded. It cannot be bounded and would carry
  user and project content.

## Limitations

The data is voluntary and self-reported. Report rates will vary by agent and
model, agents may over- or under-report what they read, and reports are
recalled at the end of a task rather than observed. Treat the data as relative
page usage among reporting agents, not absolute readership.

Self-modifying agents read docs through the read-only `/eve-docs` sandbox
mount and cannot run the CLI. They are out of scope.

## Alternatives

- **`eve docs <topic>`** serves pages through the CLI and records reads
  automatically. Its signal is accurate, but agents must stop using their own
  file tools, which they prefer. It can be added later and share the same
  event.
- **Web-first docs** through `llms.txt` and eve.dev `.md` routes give
  server-side analytics, but agents may read docs for a different version than
  the one installed.
- **Inferring usage** from command failures and docs links in error messages
  needs no agent cooperation, but says little about which pages agents read.

## Success criteria

After a few weeks of releases with the instruction, compare `telemetry:docs`
invocations against `init` invocations from the same projects. If the report rate is
too low to rank pages, prefer `eve docs <topic>` over expanding this command.
