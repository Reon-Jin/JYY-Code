export * as WorkflowValidation from "./validation"

import type { PlanPatch, RunPlan, RunPlanTask, Workflow } from "./schema"

export class WorkflowValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join("\n"))
    this.name = "WorkflowValidationError"
  }
}

function duplicateIDs(items: ReadonlyArray<{ id: string }>) {
  const seen = new Set<string>()
  return items.flatMap((item) => (seen.has(item.id) ? [item.id] : (seen.add(item.id), [])))
}

function dependencyIssues(items: ReadonlyArray<{ id: string; dependsOn: readonly string[] }>, label: string) {
  const known = new Set(items.map((item) => item.id))
  return items.flatMap((item) =>
    item.dependsOn.flatMap((dependency) => {
      if (dependency === item.id) return [`${label} ${item.id} cannot depend on itself`]
      return known.has(dependency) ? [] : [`${label} ${item.id} depends on unknown node ${dependency}`]
    }),
  )
}

function cycleIssues(items: ReadonlyArray<{ id: string; dependsOn: readonly string[] }>, label: string) {
  const nodes = new Map(items.map((item) => [item.id, item]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const issues: string[] = []
  const visit = (id: string) => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      issues.push(`${label} contains a dependency cycle at ${id}`)
      return
    }
    visiting.add(id)
    for (const dependency of nodes.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const item of items) visit(item.id)
  return issues
}

export function validateWorkflow(workflow: Workflow) {
  const issues = duplicateIDs(workflow.stages).map((id) => `Duplicate stage id: ${id}`)
  issues.push(...dependencyIssues(workflow.stages, "Stage"), ...cycleIssues(workflow.stages, "Workflow stages"))
  for (const stage of workflow.stages) {
    issues.push(...duplicateIDs(stage.steps).map((id) => `Duplicate step id in ${stage.id}: ${id}`))
    issues.push(...dependencyIssues(stage.steps, `Step in ${stage.id}`), ...cycleIssues(stage.steps, `Steps in ${stage.id}`))
    for (const step of stage.steps) {
      issues.push(...duplicateIDs(step.tasks).map((id) => `Duplicate task id in ${step.id}: ${id}`))
      issues.push(...dependencyIssues(step.tasks, `Task in ${step.id}`), ...cycleIssues(step.tasks, `Tasks in ${step.id}`))
    }
  }
  if (issues.length) throw new WorkflowValidationError(issues)
}

export function validateRunPlan(plan: RunPlan) {
  const tasks: readonly RunPlanTask[] = plan.tasks
  const issues = duplicateIDs(tasks).map((id) => `Duplicate plan task id: ${id}`)
  issues.push(...dependencyIssues(tasks, "Plan task"), ...cycleIssues(tasks, "Run plan"))
  if (issues.length) throw new WorkflowValidationError(issues)
}

export function validatePatch(plan: RunPlan, patch: PlanPatch) {
  const issues: string[] = []
  if (patch.baseVersion !== plan.version) issues.push(`Plan version conflict: expected ${plan.version}, received ${patch.baseVersion}`)
  const taskIDs = new Set(plan.tasks.map((task) => task.id))
  for (const operation of patch.operations) {
    if (operation.type === "add_task" && taskIDs.has(operation.task.id)) issues.push(`Task already exists: ${operation.task.id}`)
    if (operation.type !== "add_task" && operation.type !== "set_mode" && !taskIDs.has(operation.taskID))
      issues.push(`Task does not exist: ${operation.taskID}`)
  }
  if (issues.length) throw new WorkflowValidationError(issues)
}
