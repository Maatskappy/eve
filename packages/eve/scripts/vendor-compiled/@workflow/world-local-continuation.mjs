// Local-only correction for @workflow/world-local@5.0.1. Retain the original
// encrypted bytes in the existing claim so Eve can validate and reuse them.
// Never replace the World's byte digest with a logical operation digest.
export function continuationReplayPlugin(version) {
  if (version !== "5.0.1") {
    throw new Error(
      "Revalidate the continuation claim patch before updating @workflow/world-local.",
    );
  }
  return {
    name: "eve-local-continuation-claim-payload",
    transform(source, id) {
      const path = id.replaceAll("\\", "/");
      if (path.endsWith("/@workflow/world-local/dist/storage/events-storage.js")) {
        source = replaceOnce(
          source,
          "import assert from 'node:assert';",
          "import assert from 'node:assert';\nimport { createHash } from 'node:crypto';",
        );
        source = replaceOnce(
          source,
          "    payloadDigest: z.string().optional(),",
          "    payloadDigest: z.string().optional(),\n    evePayload: z.string().optional(),",
        );
        source = replaceOnce(
          source,
          "    const storage = {\n        clearCache,",
          `    const storage = {
        clearCache,
        async eveReadResumePayload(runId, resumeId, hookId) {
            assertSafeEntityId('runId', runId);
            const claim = await readJSON(hookResumeClaimPath(basedir, runId, resumeId), HookResumeClaimSchema);
            if (!claim || claim.evePayload === undefined) return undefined;
            if (claim.runId !== runId || claim.resumeId !== resumeId || claim.hookId !== hookId) {
                throw new EntityConflictError('Continuation claim identity does not match');
            }
            const payload = new Uint8Array(Buffer.from(claim.evePayload, 'base64'));
            if (createHash('sha256').update(payload).digest('hex') !== claim.payloadDigest) {
                throw new WorkflowWorldError('Continuation claim payload does not match its digest');
            }
            return payload;
        },`,
        );
        source = replaceOnce(
          source,
          "                                eventId,\n                                ...(params.resumePayloadDigest",
          `                                eventId,
                                ...(params.eveRetainResumePayload
                                    ? { evePayload: Buffer.from(data.eventData.payload).toString('base64') }
                                    : {}),
                                ...(params.resumePayloadDigest`,
        );
        // Once the event exists it is the receipt authority. Remove the duplicate
        // claim payload on the existing claim rewrite, including unchanged slots.
        source = replaceOnce(
          source,
          "                    resumeClaimRecordedId !== eventId) {",
          "                    (resumeClaimRecordedId !== eventId || params.eveRetainResumePayload)) {",
        );
        return { code: source, map: null };
      }
      if (path.endsWith("/@workflow/world-local/dist/storage/run-retention.js")) {
        source = replaceOnce(
          source,
          "        scrubHookMetadata(basedir, runId),",
          `        scrubEntityFiles(path.join(basedir, 'hooks', 'resumes'), runId, (claim) => {
            delete claim.evePayload;
        }, true),
        scrubHookMetadata(basedir, runId),`,
        );
        source = replaceOnce(
          source,
          "async function scrubEntityFiles(directory, runId, scrub) {",
          "async function scrubEntityFiles(directory, runId, scrub, hashNamed = false) {",
        );
        source = replaceOnce(
          source,
          "        if (!fileId.startsWith(`${runId}-`))",
          "        if (!hashNamed && !fileId.startsWith(`${runId}-`))",
        );
        source = replaceOnce(
          source,
          "            if (!raw)\n                continue;",
          "            if (!raw || (hashNamed && raw.runId !== runId))\n                continue;",
        );
        return { code: source, map: null };
      }
      return undefined;
    },
  };
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) {
    throw new Error(`Pinned local continuation claim patch no longer matches: ${before}`);
  }
  return source.replace(before, after);
}
