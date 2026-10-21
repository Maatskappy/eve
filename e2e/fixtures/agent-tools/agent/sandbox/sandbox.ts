import { DefaultSandbox, defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

// The compacted-image eval derives the staged attachment path under
// `/workspace`, so the fixture pins a provider rooted there instead of the
// development default `HostSandbox`.
export const environment = process.env.VERCEL
  ? DefaultSandbox.environment()
  : DockerSandbox.environment();

export default defineSandbox(async () => await environment.open());
