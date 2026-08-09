import fs from "node:fs"
import path from "node:path"

export class WorkspacePathError extends Error {
  readonly code: "OUTSIDE_RUNTIME_ROOT" | "PATH_IDENTITY_MISMATCH"
  readonly recoverable = false

  constructor(message: string, code: WorkspacePathError["code"]) {
    super(message)
    this.name = "WorkspacePathError"
    this.code = code
  }
}

function comparable(value: string) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

export function isPathInside(root: string, target: string) {
  const relative = path.relative(comparable(root), comparable(target))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

/** Resolve an existing path and the nearest-existing parent of a missing path. */
export function canonicalPath(target: string) {
  const resolved = path.resolve(target)
  if (fs.existsSync(resolved)) return fs.realpathSync.native(resolved)
  const suffix: string[] = []
  let cursor = resolved
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) return resolved
    suffix.unshift(path.basename(cursor))
    cursor = parent
  }
  return path.join(fs.realpathSync.native(cursor), ...suffix)
}

export function assertRuntimePath(input: { runtimeRoot: string; candidate: string; label: string }) {
  const root = canonicalPath(input.runtimeRoot)
  const candidate = canonicalPath(input.candidate)
  if (!isPathInside(root, candidate) || comparable(root) === comparable(candidate))
    throw new WorkspacePathError(`${input.label} is outside the owning runtime root`, "OUTSIDE_RUNTIME_ROOT")
  return candidate
}

export function assertWorkspaceIdentity(input: {
  actual: { rootSessionId: string; taskId: string; name: string }
  expected: { rootSessionId: string; taskId: string; name?: string }
}) {
  if (
    input.actual.rootSessionId !== input.expected.rootSessionId ||
    input.actual.taskId !== input.expected.taskId ||
    (input.expected.name !== undefined && input.actual.name !== input.expected.name)
  )
    throw new WorkspacePathError(
      "workspace metadata identity does not match the cleanup request",
      "PATH_IDENTITY_MISMATCH",
    )
}

export function assertManifestIdentity(
  value: unknown,
  expected: { rootSessionId: string; taskId: string; name?: string; baselineId?: string | null },
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WorkspacePathError("baseline manifest identity is missing", "PATH_IDENTITY_MISMATCH")
  const manifest = value as Record<string, unknown>
  if (
    manifest.root_session_id !== expected.rootSessionId ||
    manifest.task_id !== expected.taskId ||
    (expected.name !== undefined && manifest.name !== expected.name) ||
    (expected.baselineId !== undefined && manifest.baseline_id !== expected.baselineId)
  )
    throw new WorkspacePathError(
      "baseline manifest identity does not match the cleanup request",
      "PATH_IDENTITY_MISMATCH",
    )
}

export * as WorkspacePath from "./workspace-path"
