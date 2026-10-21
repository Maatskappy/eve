import { parentPort, workerData } from "node:worker_threads";

import {
  compileAndStageDevelopmentGeneration,
  type DevelopmentCompileInput,
  type DevelopmentCompileMessage,
  serializeError,
} from "#internal/nitro/host/dev-compile.js";

let message: DevelopmentCompileMessage;

try {
  message = {
    ok: true,
    compilation: await compileAndStageDevelopmentGeneration(workerData as DevelopmentCompileInput),
  };
} catch (error) {
  message = { ok: false, error: serializeError(error) };
}

parentPort?.postMessage(message);
