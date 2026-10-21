import { isLinuxDockerDaemonAvailableSync } from "#execution/sandbox/bindings/local.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import type { DockerSandboxEnvironmentOptions } from "#public/sandbox/docker-sandbox.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";
import { DockerSandbox } from "#sandbox/providers/docker.js";
import { HostSandbox } from "#sandbox/providers/host.js";
import { createDefaultVercelEnvironment } from "#sandbox/providers/vercel.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export interface DefaultSandboxEnvironmentOptions {
  readonly docker?: DockerSandboxEnvironmentOptions;
  readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
  readonly vercel?: VercelSandboxCreateOptions;
}

export interface DefaultSandboxProbes {
  readonly isDeployedOnVercel: () => boolean;
  readonly isDevelopment: () => boolean;
  readonly isDockerAvailable: () => boolean;
  readonly isPosixHost: () => boolean;
}

const SANDBOX_PROVIDER_PROBES: DefaultSandboxProbes = {
  isDeployedOnVercel: () => Boolean(process.env.VERCEL),
  isDevelopment: isEveDevEnvironment,
  isDockerAvailable: () => isLinuxDockerDaemonAvailableSync(),
  isPosixHost: () => process.platform !== "win32",
};

const NO_SANDBOX_PROVIDER_MESSAGE =
  "DefaultSandbox found no sandbox provider: this process is not deployed on Vercel, is not " +
  "running under `eve dev` or `eve eval` on macOS or Linux, and cannot reach a Docker daemon. " +
  "Start Docker, deploy to Vercel to use Vercel Sandbox, or choose a provider in " +
  "agent/sandbox/sandbox.ts. To run commands directly on a macOS or Linux machine without " +
  'isolation, use `HostSandbox.environment()` from "eve/sandbox/host".';

// Preparation is a no-op so builds succeed on any host; only opening fails.
const UnavailableSandbox = defineSandboxProvider({
  name: "default",
  environment: () => ({
    // Nothing was ever opened, so there is nothing to clean up.
    async onSessionEnd() {},
    async prepare() {
      return {};
    },
    async resume() {
      throw new Error(NO_SANDBOX_PROVIDER_MESSAGE);
    },
    async start() {
      throw new Error(NO_SANDBOX_PROVIDER_MESSAGE);
    },
  }),
});

export const DefaultSandbox = defineDefaultSandboxProvider(SANDBOX_PROVIDER_PROBES);

export function defineDefaultSandboxProvider(probes: DefaultSandboxProbes) {
  return {
    name: "default",
    environment(options: DefaultSandboxEnvironmentOptions = {}): SandboxEnvironment<undefined> {
      if (probes.isDeployedOnVercel()) {
        return withoutOpenOptions(
          createDefaultVercelEnvironment(withPreparation(options.vercel, options.prepare)),
        );
      }
      // The host sandbox needs bash and POSIX process groups, which Windows lacks.
      if (probes.isDevelopment() && probes.isPosixHost()) {
        return HostSandbox.environment(withPreparation({}, options.prepare));
      }
      if (probes.isDockerAvailable()) {
        return withoutOpenOptions(
          DockerSandbox.environment(withPreparation(options.docker, options.prepare)),
        );
      }
      return UnavailableSandbox.environment();
    },
  };
}

function withPreparation<Options extends object>(
  options: Options | undefined,
  prepare: ((sandbox: SandboxSession) => Promise<void> | void) | undefined,
) {
  return Object.assign({}, options, prepare === undefined ? {} : { prepare });
}

function withoutOpenOptions<Options extends object | undefined>(
  environment: SandboxEnvironment<Options>,
): SandboxEnvironment<undefined> {
  return environment as SandboxEnvironment<undefined>;
}
