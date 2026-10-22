import { compileAgentInWorkspace } from "#compiler/compile-agent.js";
import { stageDevelopmentGeneration } from "#internal/nitro/development-generation.js";
import type {
  DevelopmentCompilation,
  DevelopmentCompileInput,
} from "#internal/nitro/host/dev-compile.js";

export async function compileAndStageDevelopmentGeneration(
  input: DevelopmentCompileInput,
): Promise<DevelopmentCompilation> {
  const compileResult = await compileAgentInWorkspace(input);
  return { compileResult, generation: await stageDevelopmentGeneration(compileResult) };
}
