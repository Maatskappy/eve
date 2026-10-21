import { defineSandbox } from "eve/sandbox";
import { HostSandbox } from "eve/sandbox/host";
import { VercelSandbox } from "eve/sandbox/vercel";

// Vercel Sandbox when deployed, and the host sandbox elsewhere so the eval needs no
// container runtime.
export const environment = process.env.VERCEL
  ? VercelSandbox.environment()
  : HostSandbox.environment();

export default defineSandbox(() => environment.open());
