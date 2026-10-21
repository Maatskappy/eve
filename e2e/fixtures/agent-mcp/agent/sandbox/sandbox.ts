import { DefaultSandbox, defineSandbox } from "eve/sandbox";

import { JustBashSandbox } from "../lib/just-bash";

// A keyed tool session needs a provider that finds its sandbox again from the
// session id: Vercel Sandbox on Vercel, and elsewhere the just-bash backend from
// docs/sandbox/just-bash.mdx, which keeps that guide's code under CI.
export const environment = process.env.VERCEL
  ? DefaultSandbox.environment()
  : JustBashSandbox.environment();

export default defineSandbox(async () => await environment.open());
