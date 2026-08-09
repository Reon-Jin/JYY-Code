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

export async function directoryBytes(root: string, limit = Number.MAX_SAFE_INTEGER) {
  let total = 0
  async function walk(current: string): Promise<void> {
    if (total >= limit) return
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      if (total >= limit) return
      const pathname = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(pathname)
      else if (entry.isFile()) total += (await fs.promises.stat(pathname)).size
    }
  }
  try {
    await walk(root)
  } catch {
    return total
  }
  return total
}

export async function preflightWorkspaceBudget(input: {
  runtimeRoot: string
  manifest: Pick<SnapshotManifest, "total_bytes">
  taskCount: number
  softLimitBytes?: number
  hardLimitBytes?: number
}) {
  const hardLimitBytes = input.hardLimitBytes ?? 2 * 1024 * 1024 * 1024
  const currentBytes = await directoryBytes(input.runtimeRoot, hardLimitBytes + 1)
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
