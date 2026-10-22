import { getHeapStatistics } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";

import {
  adoptLinuxDockerDaemonAvailability,
  peekLinuxDockerDaemonAvailability,
} from "#execution/sandbox/bindings/docker-cli.js";
import {
  DEVELOPMENT_COMPILE_MESSAGE_KIND,
  type DevelopmentCompileOutcome,
  type DevelopmentCompileRequest,
  type DevelopmentCompileResponse,
  type DevelopmentCompileWorkerData,
  serializeError,
} from "#internal/nitro/host/dev-compile.js";
import { compileAndStageDevelopmentGeneration } from "#internal/nitro/host/dev-compile-job.js";

const { dockerAvailability } = workerData as DevelopmentCompileWorkerData;
if (dockerAvailability !== undefined) {
  adoptLinuxDockerDaemonAvailability(dockerAvailability);
}

parentPort?.on("message", async (request: Partial<DevelopmentCompileRequest> | null) => {
  if (request?.kind !== DEVELOPMENT_COMPILE_MESSAGE_KIND || request.input === undefined) {
    return;
  }

  if (request.environment !== undefined) {
    replaceEnvironment(request.environment);
  }

  // While a build runs, only its own work keeps this thread alive. A build that
  // can never settle then exits the worker and fails, instead of hanging.
  parentPort?.unref();
  let outcome: DevelopmentCompileOutcome;

  try {
    outcome = { ok: true, compilation: await compileAndStageDevelopmentGeneration(request.input) };
  } catch (error) {
    outcome = { ok: false, error: serializeError(error) };
  }

  parentPort?.ref();
  const memory = process.memoryUsage();
  const response: DevelopmentCompileResponse = {
    ...outcome,
    dockerAvailability: peekLinuxDockerDaemonAvailability(),
    heapLimit: getHeapStatistics().heap_size_limit,
    id: request.id ?? 0,
    kind: DEVELOPMENT_COMPILE_MESSAGE_KIND,
    memoryUsed: memory.heapUsed + memory.external,
  };
  parentPort?.postMessage(response);
});

// Each build sees exactly the dev server's environment, and nothing an earlier build set.
function replaceEnvironment(environment: Readonly<Record<string, string | undefined>>): void {
  for (const key of Object.keys(process.env)) {
    if (environment[key] === undefined) delete process.env[key];
  }

  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) process.env[key] = value;
  }
}
