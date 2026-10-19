import fs from "node:fs"
import path from "node:path"
import type { SnapshotManifest } from "./snapshot-manifest"

export const WORKSPACE_QUOTA_EXCEEDED = "WORKSPACE_QUOTA_EXCEEDED" as const

export type WorkspaceBudget = {
  softLimitBytes: number
  hardLimitBytes: number
  baselineBytes: number
  childBytes: number
  taskCount: number
  estimatedNewBytes: number
  currentBytes: number
  projectedBytes: number
}

export class WorkspaceQuotaError extends Error {
  readonly code = WORKSPACE_QUOTA_EXCEEDED
  readonly recoverable = true
  readonly budget: WorkspaceBudget

  constructor(budget: WorkspaceBudget) {
    super(
      `snapshot dispatch exceeds the runtime workspace quota (${budget.projectedBytes} > ${budget.hardLimitBytes} bytes); estimated new bytes: ${budget.estimatedNewBytes}`,
    )
    this.name = "WorkspaceQuotaError"
    this.budget = budget
  }
}

export function estimateSnapshotCost(input: {
  manifest: Pick<SnapshotManifest, "total_bytes">
  taskCount: number
  currentBytes?: number
  softLimitBytes?: number
  hardLimitBytes?: number
}): WorkspaceBudget {
  const baselineBytes = input.manifest.total_bytes
  const childBytes = input.manifest.total_bytes
  const estimatedNewBytes = baselineBytes + childBytes * Math.max(0, input.taskCount)
  const currentBytes = input.currentBytes ?? 0
  const softLimitBytes = input.softLimitBytes ?? Math.floor(1.5 * 1024 * 1024 * 1024)
  const hardLimitBytes = input.hardLimitBytes ?? 2 * 1024 * 1024 * 1024
  return {
    softLimitBytes,
    hardLimitBytes,
    baselineBytes,
    childBytes,
    taskCount: input.taskCount,
    estimatedNewBytes,
    currentBytes,
    projectedBytes: currentBytes + estimatedNewBytes,
  }
}

export async function directoryBytes(root: string, limit = Number.MAX_SAFE_INTEGER, signal?: AbortSignal) {
  signal?.throwIfAborted()
  let total = 0
  // Incremental baselines hardlink unchanged files, so count each inode once
  // instead of charging every link against the runtime quota.
  const seen = new Set<string>()
  const pending = [{ pathname: root, directory: true }]
  // Bound filesystem pressure across the entire tree, including directories.
  // Recursive Promise.all would multiply concurrency at every directory level.
  for (let next = 0; next < pending.length; ) {
    signal?.throwIfAborted()
    if (total >= limit) break
    const batch = pending.slice(next, next + 32)
    next += batch.length
    await Promise.all(
      batch.map(async ({ pathname, directory }) => {
        if (total >= limit) return
        try {
          if (directory) {
            for (const entry of await fs.promises.readdir(pathname, { withFileTypes: true })) {
              if (entry.isDirectory() || entry.isFile())
                pending.push({ pathname: path.join(pathname, entry.name), directory: entry.isDirectory() })
            }
            return
          }
          // Windows file IDs can exceed Number.MAX_SAFE_INTEGER. Rounding
          // those IDs would incorrectly deduplicate unrelated files.
          const stat = await fs.promises.stat(pathname, { bigint: true })
          if (stat.ino !== 0n) {
            const key = `${stat.dev}:${stat.ino}`
            if (seen.has(key)) return
            seen.add(key)
          }
          total += Number(stat.size)
        } catch {
          // Workspaces can be removed by cleanup while their usage is scanned.
        }
      }),
    )
  }
  signal?.throwIfAborted()
  return total
}

export async function preflightWorkspaceBudget(input: {
  runtimeRoot: string
  manifest: Pick<SnapshotManifest, "total_bytes">
  taskCount: number
  softLimitBytes?: number
  hardLimitBytes?: number
  signal?: AbortSignal
}) {
  const hardLimitBytes = input.hardLimitBytes ?? 2 * 1024 * 1024 * 1024
  const currentBytes = await directoryBytes(input.runtimeRoot, hardLimitBytes + 1, input.signal)
  const budget = estimateSnapshotCost({ ...input, currentBytes })
  if (budget.projectedBytes > budget.hardLimitBytes) throw new WorkspaceQuotaError(budget)
  return budget
}

export function isWorkspaceQuotaError(error: unknown): error is WorkspaceQuotaError {
  return (
    error instanceof WorkspaceQuotaError ||
    (error !== null && typeof error === "object" && "code" in error && error.code === WORKSPACE_QUOTA_EXCEEDED)
  )
}

export * as WorkspaceBudgetModule from "./workspace-budget"
