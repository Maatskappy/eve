import { Worker } from "node:worker_threads";

// Type-only compiler imports keep this module cheap, so the dev server can start
// the worker before loading the compiler itself.
import type { compileAgentInWorkspace, CompileAgentResult } from "#compiler/compile-agent.js";
import type { DevelopmentGeneration } from "#internal/nitro/development-generation.js";
import { toError, toErrorMessage } from "#shared/errors.js";

export type DevelopmentCompileInput = Parameters<typeof compileAgentInWorkspace>[0];

export interface DevelopmentCompilation {
  readonly compileResult: CompileAgentResult;
  readonly generation: DevelopmentGeneration;
}

// Authored code also runs in the worker and may post its own messages to `parentPort`.
export const DEVELOPMENT_COMPILE_MESSAGE_KIND = "eve:development-compile";

export interface DevelopmentCompileWorkerData {
  /** Probe result from an earlier worker, adopted before anything can probe again. */
  readonly dockerAvailability: boolean | undefined;
}

export interface DevelopmentCompileRequest {
  /** The dev server's environment, including `.env` changes staged for this rebuild. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly id: number;
  readonly input: DevelopmentCompileInput;
  readonly kind: typeof DEVELOPMENT_COMPILE_MESSAGE_KIND;
}

export type DevelopmentCompileOutcome =
  | { readonly ok: true; readonly compilation: DevelopmentCompilation }
  | { readonly ok: false; readonly error: SerializedError };

export type DevelopmentCompileResponse = {
  readonly dockerAvailability: boolean | undefined;
  readonly heapLimit: number;
  /** Heap plus memory held outside it by JavaScript objects, such as buffers. */
  readonly memoryUsed: number;
  readonly id: number;
  readonly kind: typeof DEVELOPMENT_COMPILE_MESSAGE_KIND;
} & DevelopmentCompileOutcome;

interface SerializedError {
  cause?: SerializedError;
  message: string;
  name: string;
  stack?: string;
}

const MAX_SERIALIZED_CAUSE_DEPTH = 8;
const WORKER_HEAP_RECYCLE_FRACTION = 0.25;

let compileWorker: Worker | undefined;
let busyWorker: Worker | undefined;
let compileQueue: Promise<unknown> = Promise.resolve();
let dockerAvailability: boolean | undefined;
let nextRequestId = 0;

/**
 * Compiles the agent and stages its runtime generation in a compile worker.
 * Both steps bundle and import authored source, which the dev server would
 * otherwise keep in memory until it restarts: Node never unloads an imported
 * module, and Rolldown can keep a finished build's plugins reachable.
 *
 * The worker stays warm between rebuilds, because a fresh one repeats the
 * compiler's cold start on every save. Once its heap passes a fraction of the
 * limit it is replaced, which bounds memory, and a rebuild that exhausts the
 * heap fails instead of crashing the server.
 */
export function compileDevelopmentGeneration(
  input: DevelopmentCompileInput,
): Promise<DevelopmentCompilation> {
  // eve's own tests load this module from TypeScript source, which a worker
  // thread cannot import without the test runner's transform.
  if (import.meta.url.endsWith(".ts")) {
    return import("#internal/nitro/host/dev-compile-job.js").then((job) =>
      job.compileAndStageDevelopmentGeneration(input),
    );
  }

  const compilation = compileQueue.then(() => compileInWorker(input));
  compileQueue = compilation.catch(() => undefined);
  return compilation;
}

/** Starts the compile worker so it loads the compiler while the dev server loads. */
export function prewarmDevelopmentCompileWorker(): void {
  if (!import.meta.url.endsWith(".ts")) {
    compileWorker ??= startCompileWorker();
  }
}

async function compileInWorker(input: DevelopmentCompileInput): Promise<DevelopmentCompilation> {
  const worker = (compileWorker ??= startCompileWorker());
  let response: DevelopmentCompileResponse;

  try {
    response = await requestCompilation(worker, {
      environment: { ...process.env },
      id: ++nextRequestId,
      input,
      kind: DEVELOPMENT_COMPILE_MESSAGE_KIND,
    });
  } catch (error) {
    retireCompileWorker(worker);

    if ((error as { code?: unknown } | null)?.code === "ERR_WORKER_OUT_OF_MEMORY") {
      throw new Error(
        "Compiling the agent ran out of memory. Reduce what authored modules import when they load, or raise the heap limit with NODE_OPTIONS=--max-old-space-size=<megabytes>.",
        { cause: error },
      );
    }

    throw error;
  }

  // Provider selection must stay stable for the dev server's lifetime, including across workers.
  dockerAvailability ??= response.dockerAvailability;

  if (response.memoryUsed > response.heapLimit * WORKER_HEAP_RECYCLE_FRACTION) {
    retireCompileWorker(worker);
  }

  if (!response.ok) {
    throw deserializeError(response.error);
  }

  return response.compilation;
}

function startCompileWorker(): Worker {
  const workerData: DevelopmentCompileWorkerData = { dockerAvailability };
  const worker = new Worker(new URL("./dev-compile-worker.js", import.meta.url), { workerData });
  const forget = () => {
    if (compileWorker === worker) compileWorker = undefined;
  };

  // Authored code can still throw from a timer after its build finished. A build in progress
  // reports its own failure; between builds, nothing else would surface it.
  worker.on("error", (error) => {
    if (busyWorker !== worker) {
      console.error(
        `[eve:dev] agent compiler worker failed between rebuilds: ${toErrorMessage(error)}`,
      );
    }
    forget();
  });
  worker.once("exit", forget);
  worker.unref();
  return worker;
}

function requestCompilation(
  worker: Worker,
  request: DevelopmentCompileRequest,
): Promise<DevelopmentCompileResponse> {
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void) => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      worker.unref();
      busyWorker = undefined;
      finish();
    };
    const onMessage = (message: Partial<DevelopmentCompileResponse> | null) => {
      if (message?.kind === DEVELOPMENT_COMPILE_MESSAGE_KIND && message.id === request.id) {
        settle(() => resolve(message as DevelopmentCompileResponse));
      }
    };
    const onError = (error: Error) => settle(() => reject(error));
    const onExit = (code: number) =>
      settle(() =>
        reject(
          new Error(
            code === 0
              ? "Compiling the agent stopped before it finished, because it was waiting on work that can never complete. Check authored modules for top-level awaits on promises that never settle."
              : `The agent compiler worker exited with code ${code} before finishing.`,
          ),
        ),
      );

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.ref();
    busyWorker = worker;
    worker.postMessage(request);
  });
}

/** Stops the compile worker, so a build that never settles cannot block shutdown. */
export function terminateDevelopmentCompileWorker(): void {
  if (compileWorker !== undefined) retireCompileWorker(compileWorker);
}

function retireCompileWorker(worker: Worker): void {
  if (compileWorker === worker) compileWorker = undefined;
  void worker.terminate();
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
