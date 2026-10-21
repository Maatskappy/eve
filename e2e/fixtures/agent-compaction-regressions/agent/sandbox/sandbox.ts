import { DefaultSandbox, defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

// The compaction budget in agent.ts must fit the content-output case's capped
// file stub, which names the staged file's sandbox path. Docker keeps that path
// at `/workspace/.eve/attachments/...` on every machine; the development default
// HostSandbox stages under a longer, machine-specific directory.
export const environment = process.env.VERCEL
  ? DefaultSandbox.environment()
  : DockerSandbox.environment();

export default defineSandbox(async () => await environment.open());
