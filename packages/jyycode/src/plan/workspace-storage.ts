import { createHash } from "node:crypto"
import path from "node:path"
import { canonicalPath } from "./workspace-path"

/** All non-Git projects have project ID "global"; their directory is the identity. */
export function snapshotProjectKey(directory: string) {
  const canonical = canonicalPath(directory)
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical
  return createHash("sha256").update(identity).digest("hex").slice(0, 24)
}

export function snapshotRuntimeRoot(dataRoot: string, directory: string) {
  return path.join(dataRoot, "plan-workspaces", "projects", snapshotProjectKey(directory))
}

export function legacySnapshotRuntimeRoots(dataRoot: string) {
  return [path.join(dataRoot, "plan-workspaces", "global"), path.join(dataRoot, "global")]
}
