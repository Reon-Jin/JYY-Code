import fs from "node:fs"
import path from "node:path"
import type { PlanFile, PlanTask } from "./schema"
import { readPlanFileSync } from "./schema"

const CHILD_WORKSPACE_PATTERN =
  /^(?:jyycode-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+-[a-f0-9]{12}(?:\.baseline|\.manifest\.json|\.lease\.json)?|baseline-[a-f0-9]{24}(?:\.source\.json)?)$/
const MERGE_JOURNAL_PATTERN = /^\.jyycode-merge-[a-f0-9]{16}$/

export type StartupWorkspaceCleanupResult = {
  removed: string[]
  preserved: string[]
  skippedPlans: string[]
  failures: Array<{ path: string; message: string }>
}

function pathWithin(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function isGeneratedWorkspace(name: string) {
  return CHILD_WORKSPACE_PATTERN.test(name) || MERGE_JOURNAL_PATTERN.test(name)
}

function preserveTaskWorkspace(task: PlanTask) {
  const merge = task.merge
  const mergedCleanupCompleted =
    merge?.status === "merged" && (merge.cleanup_record?.state === "completed" || merge.cleanup === "completed")
  if (mergedCleanupCompleted) return false
  return (
    task.status === "dispatched" ||
    task.status === "running" ||
    task.status === "reported" ||
    task.status === "approved" ||
    (merge !== undefined &&
      (merge.status === "pending" ||
        merge.status === "running" ||
        merge.status === "conflict" ||
        merge.cleanup !== "completed"))
  )
}

function addPath(set: Set<string>, root: string, value: string | null | undefined) {
  if (!value) return
  const resolved = path.resolve(value)
  if (pathWithin(root, resolved) && resolved !== path.resolve(root)) {
    set.add(resolved)
    if (path.basename(resolved).startsWith("jyycode-") && !resolved.endsWith(".json"))
      set.add(path.join(path.dirname(resolved), `${path.basename(resolved)}.lease.json`))
    if (path.basename(resolved).startsWith("baseline-") && !resolved.endsWith(".json"))
      set.add(path.join(path.dirname(resolved), `${path.basename(resolved)}.source.json`))
  }
}

function activePathsFromPlan(plan: PlanFile, runtimeRoot: string) {
  const active = new Set<string>()
  for (const task of plan.steps.flatMap((step) => step.tasks)) {
    if (!preserveTaskWorkspace(task)) continue
    addPath(active, runtimeRoot, task.dispatch?.workspace?.directory)
    addPath(active, runtimeRoot, task.dispatch?.workspace?.baseline_directory)
    addPath(active, runtimeRoot, task.dispatch?.workspace?.baseline_manifest_path)
    addPath(active, runtimeRoot, task.merge?.journal_directory)
  }
  return active
}

function collectActivePaths(
  runtimeRoot: string,
  workspaceRoots: readonly string[],
  result: StartupWorkspaceCleanupResult,
) {
  const active = new Set<string>()
  const seenPlanFiles = new Set<string>()
  for (const workspaceRoot of new Set(workspaceRoots.map((item) => path.resolve(item)))) {
    const planRoot = path.join(workspaceRoot, ".jyycode", "plan")
    if (!fs.existsSync(planRoot)) continue
    let sessions: fs.Dirent[]
    try {
      sessions = fs.readdirSync(planRoot, { withFileTypes: true })
    } catch (error) {
      result.failures.push({
        path: planRoot,
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const planPath = path.join(planRoot, session.name, "plan.json")
      if (!fs.existsSync(planPath) || seenPlanFiles.has(path.resolve(planPath))) continue
      seenPlanFiles.add(path.resolve(planPath))
      try {
        for (const value of activePathsFromPlan(readPlanFileSync(planPath)!, runtimeRoot)) active.add(value)
      } catch (error) {
        result.skippedPlans.push(planPath)
        result.failures.push({
          path: planPath,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return active
}

/** Remove orphaned non-Git plan workspaces and merge journals at application startup. */
export function cleanupStartupPlanWorkspaces(input: {
  runtimeRoot: string
  workspaceRoots: readonly string[]
}): StartupWorkspaceCleanupResult {
  const runtimeRoot = path.resolve(input.runtimeRoot)
  const result: StartupWorkspaceCleanupResult = { removed: [], preserved: [], skippedPlans: [], failures: [] }
  if (!fs.existsSync(runtimeRoot)) return result

  const active = collectActivePaths(runtimeRoot, input.workspaceRoots, result)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(runtimeRoot, { withFileTypes: true })
  } catch (error) {
    result.failures.push({ path: runtimeRoot, message: error instanceof Error ? error.message : String(error) })
    return result
  }

  for (const entry of entries) {
    if (!isGeneratedWorkspace(entry.name)) continue
    const target = path.resolve(runtimeRoot, entry.name)
    if (active.has(target)) {
      result.preserved.push(target)
      continue
    }
    try {
      fs.rmSync(target, { recursive: true, force: true })
      result.removed.push(target)
    } catch (error) {
      result.failures.push({ path: target, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

export * as StartupCleanupModule from "./startup-cleanup"
