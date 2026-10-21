import { Worker } from "node:worker_threads";

import { compileAgentInWorkspace, type CompileAgentResult } from "#compiler/compile-agent.js";
import {
  type DevelopmentGeneration,
  stageDevelopmentGeneration,
} from "#internal/nitro/development-generation.js";
import { toError } from "#shared/errors.js";

export type DevelopmentCompileInput = Parameters<typeof compileAgentInWorkspace>[0];

export interface DevelopmentCompilation {
  readonly compileResult: CompileAgentResult;
  readonly generation: DevelopmentGeneration;
}

export type DevelopmentCompileMessage =
  | { readonly ok: true; readonly compilation: DevelopmentCompilation }
  | { readonly ok: false; readonly error: SerializedError };

interface SerializedError {
  cause?: SerializedError;
  message: string;
  name: string;
  stack?: string;
}

const MAX_SERIALIZED_CAUSE_DEPTH = 8;

/**
 * Compiles the agent and stages its runtime generation in a short-lived worker
 * thread. Both steps bundle and import authored source, and the dev server
 * would otherwise keep each rebuild's copy in memory until it restarts: Node
 * never unloads an imported module, and Rolldown can keep a finished build's
 * plugins reachable. Terminating the worker releases all of it, and a rebuild
 * that exhausts the heap fails instead of crashing the server.
 */
export async function compileDevelopmentGeneration(
  input: DevelopmentCompileInput,
): Promise<DevelopmentCompilation> {
  // Source checkouts run this module as TypeScript under Vitest, and a worker
  // thread cannot load that source without the test runner's transform.
  if (import.meta.url.endsWith(".ts")) {
    return await compileAndStageDevelopmentGeneration(input);
  }

  const worker = new Worker(new URL("./dev-compile-worker.js", import.meta.url), {
    workerData: input,
  });

  try {
    const message = await new Promise<DevelopmentCompileMessage>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        reject(new Error(`The agent compiler worker exited with code ${code} before finishing.`));
      });
    });

    if (!message.ok) {
      throw deserializeError(message.error);
    }

    return message.compilation;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_WORKER_OUT_OF_MEMORY") {
      throw new Error(
        "Compiling the agent ran out of memory. Reduce what authored modules import when they load, or raise the heap limit with NODE_OPTIONS=--max-old-space-size=<megabytes>.",
        { cause: error },
      );
    }

    throw error;
  } finally {
    // Authored modules can leave timers or handles open, so the worker never exits on its own.
    await worker.terminate();
  }
}

export async function compileAndStageDevelopmentGeneration(
  input: DevelopmentCompileInput,
): Promise<DevelopmentCompilation> {
  const compileResult = await compileAgentInWorkspace(input);
  return { compileResult, generation: await stageDevelopmentGeneration(compileResult) };
}

export function serializeError(error: unknown, depth = 0): SerializedError {
  const value = toError(error);
  const cause = (value as { cause?: unknown }).cause;
  const serialized: SerializedError = { message: value.message, name: value.name };

  if (value.stack !== undefined) {
    serialized.stack = value.stack;
  }

  if (cause !== undefined && depth < MAX_SERIALIZED_CAUSE_DEPTH) {
    serialized.cause = serializeError(cause, depth + 1);
  }

  return serialized;
}

function deserializeError(serialized: SerializedError): Error {
  const error = toError(serialized);

  if (serialized.cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = deserializeError(serialized.cause);
  }

  return error;
}
