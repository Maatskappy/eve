import { join } from "node:path";

import { defineDynamic, defineInstructions } from "eve/instructions";
import { getLocalDevCapability } from "eve/local-dev";

import { resolveSelfModificationConfig } from "../../../config.js";
import { isLocalSelfModificationEnabled } from "../../../mode.js";
import {
  LOCAL_DOCS_PATH,
  LOCAL_LOGS_PATH,
  LOCAL_SOURCE_PATH,
  LOCAL_TRACES_PATH,
} from "../../../paths.js";
import { renderLocalSelfModificationExtension } from "../../../scaffold.js";
import {
  documentationInstructions,
  registryWorkflowInstructions,
  renderInstructions,
  roleInstructions,
  sourceEditingInstructions,
  sourceWorkspaceInstructions,
  toolAuthoringInstructions,
  workingInstructions,
} from "../../../subagent-guidance.js";
import selfModification from "../../extension.js";

const localReportingGuidance = `## Report results

For source-modification tasks, return a concise handoff to the caller. Use at most four short bullets covering changed paths and behavior, and any required setup or unresolved issues.

For investigation tasks, report the findings and supporting evidence requested by the caller.`;

function localGuidance(appRoot: string): string {
  return `## Local environment

The sandbox is this machine's shell, started in the application directory ${appRoot}. It runs as the developer, with the real filesystem and installed tools, so it is not isolated: stay inside the application directory and never touch credentials, dotfiles, or files outside it.

Run git, pnpm, node, or tsc when they help. For example, run the project's typecheck after editing TypeScript, and use git status or git diff to review your changes. Do not commit, push, install dependencies, or start long-running processes such as eve dev unless the requester asks. Change source only with edit_file and write_file inside ${join(appRoot, LOCAL_SOURCE_PATH)}, never with shell commands. Use registry_add for supported registry installations, and do not edit package.json or lockfiles yourself.

The registry_add tool will complete installation for items that need no setup. In the local dev TUI, a \`needs-terminal\` result queues the existing setup panel, which opens after your reply and reports the setup outcome itself. Until then nothing is installed: say that setup continues in the panel and never describe the item as added, connected, or set up. In headless development, if a \`needs-terminal\` result includes \`nextCommand\`, present that exact value as the only shell command in your response. Never infer, construct, or rewrite a command: installing an item uses \`eve add <item>\`; \`eve registry add\` configures registry namespace mappings and does not install items.

Local eve dev logs are in ${join(appRoot, LOCAL_LOGS_PATH)}. Local trace segments are in ${join(appRoot, LOCAL_TRACES_PATH)} when available. Read them, but do not modify them. For latency, failure, token, or behavior analysis, load and follow the \`trace_analysis\` skill. Trace searches are scoped to the invoking conversation and exclude the current investigation by default.`;
}

function selfModificationSubagentGuidance(sourceRoot: string): string {
  return `## Changing the self-modification subagent

Only when the requester explicitly names the self-modification subagent, edit whichever of ${sourceRoot}/extensions/self-modification.ts or ${sourceRoot}/extensions/self-modification/extension.ts exists. If neither exists, create ${sourceRoot}/extensions/self-modification/extension.ts with write_file using this content, then make the requested model or reasoning change:
\`\`\`ts
${renderLocalSelfModificationExtension()}\`\`\``;
}

export default defineDynamic({
  events: {
    "session.started": () => {
      const appRoot = getLocalDevCapability()?.appRoot;
      if (
        appRoot === undefined ||
        !isLocalSelfModificationEnabled(resolveSelfModificationConfig(selfModification.config))
      ) {
        return null;
      }

      const sourceRoot = join(appRoot, LOCAL_SOURCE_PATH);
      return defineInstructions({
        markdown: renderInstructions([
          roleInstructions,
          sourceWorkspaceInstructions(sourceRoot),
          sourceEditingInstructions,
          toolAuthoringInstructions(sourceRoot),
          registryWorkflowInstructions,
          documentationInstructions(join(appRoot, LOCAL_DOCS_PATH)),
          localGuidance(appRoot),
          workingInstructions,
          selfModificationSubagentGuidance(sourceRoot),
          localReportingGuidance,
        ]),
      });
    },
  },
});
