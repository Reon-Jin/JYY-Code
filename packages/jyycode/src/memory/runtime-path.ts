import path from "path"
import { createHash } from "crypto"
import { Global } from "@jyycode-ai/core/global"

/** The pre-runtime memory location is only a migration source when explicitly selected. */
export const LEGACY_MEMORY_DIRECTORY = path.normalize("D:/jyycode/memory")
export const MEMORY_DIRECTORY = path.join(Global.Path.data, "memory")
export const EXPERIENCE_DIRECTORY = path.join(Global.Path.data, "experience")
/** Experience stores created before workspace isolation lived beside MEMORY.json. */
export const LEGACY_EXPERIENCE_DIRECTORY = MEMORY_DIRECTORY

export function normalizeWorkspaceRoot(root: string): string {
  const resolved = path.resolve(root.trim() || path.parse(process.cwd()).root)
  return (
    path
      .normalize(resolved)
      .replace(/[\\/]+$/u, "")
      .toLowerCase() || path.parse(resolved).root.toLowerCase()
  )
}

/** Stable, provider-safe identifier for a workspace-scoped persistence directory. */
export function workspaceIDForRoot(root: string): string {
  return createHash("sha256").update(normalizeWorkspaceRoot(root), "utf8").digest("hex").slice(0, 24)
}

export function workspaceDirectory(baseDirectory: string, workspaceRoot?: string): string {
  return workspaceRoot
    ? path.join(path.normalize(baseDirectory), workspaceIDForRoot(workspaceRoot))
    : path.normalize(baseDirectory)
}

export function isLegacyMemoryDirectory(directory: string): boolean {
  return path.resolve(directory).toLowerCase() === path.resolve(LEGACY_MEMORY_DIRECTORY).toLowerCase()
}
