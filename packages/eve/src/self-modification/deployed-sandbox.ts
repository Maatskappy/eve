import { defineSandbox } from "#public/definitions/sandbox.js";
import { createDefaultVercelEnvironment } from "#sandbox/providers/vercel.js";
import { bindSandboxEnvironment, type SandboxSelector } from "#shared/sandbox-environment.js";
import { shellQuote } from "#shared/shell-quote.js";

import { createGitHubCredentialProvider } from "./credentials.js";
import { prepareSelfModificationWorkspace, REPOSITORY_PATH } from "./git-workspace.js";
import { isDeployedRuntime } from "./mode.js";
import { DEPLOYED_SOURCE_ROOT } from "./paths.js";
import { SELF_MODIFICATION_BASELINE_NETWORK_POLICY } from "./network-policy.js";
import {
  resolveDeployedSelfModificationConfig,
  type DeployedSelfModificationConfig,
} from "./remote/config.js";

const VERCEL_SANDBOX_REQUIRED_MESSAGE =
  "Deployed self-modification requires Vercel Sandbox, which provides the runtime credential transforms that keep the GitHub token out of the sandbox. Deploy this agent to Vercel, or remove the eve/self-modification/remote extension mount from self-hosted deployments.";

/**
 * Defines the deployed child's sandbox. Every build binds the default Vercel
 * environment, whose empty preparation is a no-op, so apps compile and prewarm on
 * any host. The deployed child is never offered during `eve dev`, and the Vercel
 * requirement is enforced when a deployed child opens its sandbox.
 */
export function defineDeployedSelfModificationSandbox(
  config: DeployedSelfModificationConfig,
  isDeployedOnVercel: () => boolean = () => Boolean(process.env.VERCEL),
): SandboxSelector {
  const deployed = isDeployedRuntime() ? resolveDeployedSelfModificationConfig(config) : undefined;
  const environment = createDefaultVercelEnvironment();
  return bindSandboxEnvironment(
    defineSandbox(async ({ session }) => {
      if (deployed === undefined || !isDeployedOnVercel()) {
        throw new Error(VERCEL_SANDBOX_REQUIRED_MESSAGE);
      }
      const sandbox = await environment.open({
        networkPolicy: SELF_MODIFICATION_BASELINE_NETWORK_POLICY,
      });
      if (session.parent === undefined)
        throw new Error("Production self-modification requires a child session.");
      if (sandbox.setNetworkPolicy === undefined) {
        throw new Error("Production self-modification requires mutable sandbox network policy.");
      }
      const capableSandbox = { ...sandbox, setNetworkPolicy: sandbox.setNetworkPolicy };
      const token = await createGitHubCredentialProvider(deployed.credentials).resolve({
        capability: "checkout",
        repository: deployed.repository,
      });
      await prepareSelfModificationWorkspace({
        directory: deployed.directory,
        repository: deployed.repository,
        sandbox: capableSandbox,
        targetBranch: deployed.targetBranch,
        token,
      });
      const root =
        deployed.directory === "." ? REPOSITORY_PATH : `${REPOSITORY_PATH}/${deployed.directory}`;
      const result = await sandbox.run({
        command: `rm -rf ${DEPLOYED_SOURCE_ROOT} && ln -s ${shellQuote(`${root}/agent`)} ${DEPLOYED_SOURCE_ROOT}`,
      });
      if (result.exitCode !== 0)
        throw new Error("Self-modification could not mount the agent source.");
      return sandbox;
    }),
    environment,
  );
}
