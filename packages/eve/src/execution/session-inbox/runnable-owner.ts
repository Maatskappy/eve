import type { World } from "#compiled/@workflow/world/index.js";
import {
  EVE_DEPLOYMENT_URL_ATTRIBUTE,
  EVE_VERSION_ATTRIBUTE,
} from "#execution/eve-workflow-attributes.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";

export type OwnerRun = Awaited<ReturnType<World["runs"]["get"]>>;

/** Bounds each process-wide set; a cleared entry only costs one more run read or probe. */
const OWNER_CACHE_LIMIT = 10_000;

/** A deleted deployment answers in tens of milliseconds; a slow answer is not a verdict. */
const DEPLOYMENT_PROBE_TIMEOUT_MS = 3_000;

/**
 * Owner runs this process has seen record the running eve version. A run's
 * version never changes once it starts, so a positive answer stays true for
 * the life of the process; retired owners are never cached.
 */
const runnableOwnerRuns = new Map<string, OwnerRun>();

/** A deleted deployment never comes back, so a gone verdict holds for the life of the process. */
const goneDeploymentUrls = new Set<string>();

/**
 * Whether the World replays every run on the deployment that started it
 * (Vercel). There, an owner from another eve version is the normal handoff
 * case, not a stranded one.
 */
export function routesToOwnerDeployment(world: Pick<World, "capabilities">): boolean {
  return world.capabilities?.deploymentAffinity === true;
}

/**
 * Whether this build can replay the owner run. On a World that does not route
 * each run to its own deployment, only one build serves it, so an owner that
 * records another eve version, or none, is retired: nothing can execute it again.
 */
function isRunnableOwnerRun(run: Pick<OwnerRun, "attributes">): boolean {
  return run.attributes[EVE_VERSION_ATTRIBUTE] === resolveInstalledPackageInfo().version;
}

function rememberRunnableOwner(run: OwnerRun): void {
  if (runnableOwnerRuns.size >= OWNER_CACHE_LIMIT) runnableOwnerRuns.clear();
  runnableOwnerRuns.set(run.runId, run);
}

async function readOwnerRun(
  world: Pick<World, "runs">,
  runId: string,
): Promise<{ readonly run: OwnerRun; readonly verified: boolean }> {
  const known = runnableOwnerRuns.get(runId);
  if (known !== undefined) return { run: known, verified: true };
  return { run: await world.runs.get(runId, { resolveData: "none" }), verified: false };
}

/**
 * The owner run when another eve version built it, or `undefined` when this
 * build can replay it. Reads the run only when it is not already known to be
 * runnable.
 */
export async function findRetiredOwnerRun(
  world: Pick<World, "runs">,
  runId: string,
): Promise<OwnerRun | undefined> {
  const { run, verified } = await readOwnerRun(world, runId);
  if (verified) return undefined;
  if (!isRunnableOwnerRun(run)) return run;
  rememberRunnableOwner(run);
  return undefined;
}

/**
 * The owner run when nothing can execute it, or `undefined` when it can run.
 * An owner is stranded when another eve version built it on a World that
 * replays runs on this build, or when the Vercel deployment it is pinned to
 * has been deleted: Workflow would still accept a message for it, but no
 * deployment would ever replay the run.
 */
export async function findStrandedOwnerRun(
  world: Pick<World, "capabilities" | "runs">,
  runId: string,
  fetchImpl?: typeof fetch,
): Promise<OwnerRun | undefined> {
  const { run, verified } = await readOwnerRun(world, runId);
  if (!verified) {
    if (!routesToOwnerDeployment(world) && !isRunnableOwnerRun(run)) return run;
    rememberRunnableOwner(run);
  }
  return (await isOwnerDeploymentGone(run, fetchImpl)) ? run : undefined;
}

/**
 * Whether the deployment the owner is pinned to has been deleted. Only an
 * owner on another deployment is probed: this process proves its own. Only a
 * definite "deployment not found" counts; a timeout, a network error or any
 * other status leaves the owner runnable, because wrongly ending a session
 * costs its conversation while a missed deletion only costs one more probe.
 */
async function isOwnerDeploymentGone(run: OwnerRun, fetchImpl?: typeof fetch): Promise<boolean> {
  const deploymentUrl = run.attributes[EVE_DEPLOYMENT_URL_ATTRIBUTE];
  if (deploymentUrl === undefined || deploymentUrl === process.env.VERCEL_URL?.trim()) {
    return false;
  }
  if (goneDeploymentUrls.has(deploymentUrl)) return true;
  if (!(await isDeploymentGone(deploymentUrl, fetchImpl ?? fetch))) return false;
  if (goneDeploymentUrls.size >= OWNER_CACHE_LIMIT) goneDeploymentUrls.clear();
  goneDeploymentUrls.add(deploymentUrl);
  return true;
}

async function isDeploymentGone(deploymentUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`https://${deploymentUrl}`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(DEPLOYMENT_PROBE_TIMEOUT_MS),
    });
    return (
      response.status === 404 && response.headers.get("x-vercel-error") === "DEPLOYMENT_NOT_FOUND"
    );
  } catch {
    return false;
  }
}
