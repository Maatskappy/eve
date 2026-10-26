import type { World } from "#compiled/@workflow/world/index.js";

/**
 * Makes the local World write a group of stream chunks one file at a time.
 *
 * world-local (5.1.2) writes a `writeMulti` group's chunk files in parallel. A
 * reader that lists the stream while they land can see a later chunk before
 * an earlier one and deliver them out of order, such as a `step.started`
 * before its `turn.started`. Sequential writes only ever expose a prefix.
 *
 * Mutates and returns `world`.
 */
export function orderLocalWorkflowStreamWrites<T extends Pick<World, "streams">>(world: T): T {
  world.streams.writeMulti = async (runId, name, chunks) => {
    for (const chunk of chunks) await world.streams.write(runId, name, chunk);
  };
  return world;
}
