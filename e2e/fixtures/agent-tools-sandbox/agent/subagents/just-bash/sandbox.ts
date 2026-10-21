import { defineSandbox, type SandboxSession } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

import { JustBashSandbox } from "../../lib/just-bash.js";

export const JUST_BASH_PREPARED = "just-bash-prepared-K4T";

async function prepare(sandbox: SandboxSession) {
  await sandbox.writeTextFile({ content: JUST_BASH_PREPARED, path: "prepared.txt" });
}

// The just-bash backend from docs/sandbox/just-bash.mdx, kept byte-identical in
// ../../lib/just-bash.ts. Vercel Functions cannot write the app directory it
// keeps sessions in, so deployed runs use Vercel Sandbox.
export const environment = process.env.VERCEL
  ? VercelSandbox.environment({ prepare })
  : JustBashSandbox.environment({ prepare });

export default defineSandbox(() => environment.open());
