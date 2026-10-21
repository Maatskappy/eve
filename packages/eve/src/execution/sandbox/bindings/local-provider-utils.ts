import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, mkdir, rename, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";

import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { resolveSandboxModelPath } from "#shared/skill-paths.js";

interface SandboxSeedFile {
  readonly content: string | Uint8Array;
  readonly path: string;
}

export function resolveWorkspacePath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${WORKSPACE_ROOT}/${path}`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function copyDirectoryAtomically(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  const temporaryTargetPath = `${targetPath}.${randomUUID()}.tmp`;

  await rm(temporaryTargetPath, { force: true, recursive: true });
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    // Clones copy-on-write where the filesystem supports it, and copies otherwise.
    // Symlinks keep their targets as written, so a relative link in the copy
    // points into the copy, not back into the source.
    await cp(sourcePath, temporaryTargetPath, {
      mode: constants.COPYFILE_FICLONE,
      recursive: true,
      verbatimSymlinks: true,
    });
    await rename(temporaryTargetPath, targetPath);
  } catch (error) {
    await rm(temporaryTargetPath, { force: true, recursive: true }).catch(() => {});
    if (await pathExists(targetPath)) {
      return;
    }
    throw error;
  }
}

export async function touchDirectory(path: string): Promise<void> {
  const now = new Date();
  await utimes(path, now, now);
}

export function resolveLocalProviderTemplateRootPath(
  cacheDirectory: string,
  providerCacheName: string,
  templateKey: string,
): string {
  return join(
    resolveLocalProviderTemplatesDirectory(cacheDirectory, providerCacheName),
    templateKey,
  );
}

export function resolveLocalProviderTemplatesDirectory(
  cacheDirectory: string,
  providerCacheName: string,
): string {
  return join(cacheDirectory, providerCacheName, "templates");
}

export function resolveLocalProviderSessionRootPath(
  cacheDirectory: string,
  providerCacheName: string,
  sessionKey: string,
): string {
  return join(cacheDirectory, providerCacheName, "sessions", sessionKey);
}

export async function writeSandboxSeedFiles(
  session: SandboxSession,
  seedFiles: ReadonlyArray<SandboxSeedFile>,
): Promise<void> {
  for (const file of seedFiles) {
    const path = await resolveSandboxModelPath({
      path: file.path,
      sandbox: session,
    });

    if (typeof file.content === "string") {
      await session.writeTextFile({ content: file.content, path });
    } else {
      await session.writeBinaryFile({ content: file.content, path });
    }
  }
}
