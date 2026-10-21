import { parentPort, workerData } from "node:worker_threads";

import {
  compileAndStageDevelopmentGeneration,
  DEVELOPMENT_COMPILE_MESSAGE_KIND,
  type DevelopmentCompileInput,
  type DevelopmentCompileMessage,
  serializeError,
} from "#internal/nitro/host/dev-compile.js";

let message: DevelopmentCompileMessage;

try {
  message = {
    kind: DEVELOPMENT_COMPILE_MESSAGE_KIND,
    ok: true,
    compilation: await compileAndStageDevelopmentGeneration(workerData as DevelopmentCompileInput),
  };
} catch (error) {
  message = { kind: DEVELOPMENT_COMPILE_MESSAGE_KIND, ok: false, error: serializeError(error) };
}

parentPort?.postMessage(message);
