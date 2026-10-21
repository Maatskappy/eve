import { DefaultSandbox, defineSandbox } from "eve/sandbox";
import { HostSandbox } from "eve/sandbox/host";

// A keyed tool session needs a provider that finds its sandbox again from the
// session id: Vercel Sandbox on Vercel, the host sandbox elsewhere. The
// default's production Docker provider cannot, so it is not used here.
export const environment = process.env.VERCEL
  ? DefaultSandbox.environment()
  : HostSandbox.environment();

export default defineSandbox(async () => await environment.open());
