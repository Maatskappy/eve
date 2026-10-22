import { getHeapStatistics } from "node:v8";
import { parentPort } from "node:worker_threads";

import {
  adoptLinuxDockerDaemonAvailability,
  peekLinuxDockerDaemonAvailability,
} from "#execution/sandbox/bindings/docker-cli.js";
import {
  compileAndStageDevelopmentGeneration,
  DEVELOPMENT_COMPILE_MESSAGE_KIND,
  type DevelopmentCompileOutcome,
  type DevelopmentCompileRequest,
  type DevelopmentCompileResponse,
  serializeError,
} from "#internal/nitro/host/dev-compile.js";

parentPort?.on("message", async (request: Partial<DevelopmentCompileRequest> | null) => {
  if (request?.kind !== DEVELOPMENT_COMPILE_MESSAGE_KIND || request.input === undefined) {
    return;
  }

  if (request.dockerAvailability !== undefined) {
    adoptLinuxDockerDaemonAvailability(request.dockerAvailability);
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
