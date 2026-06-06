export * as AgentClusterRuntime from "./runtime"

import type { Plan, PlannedTask, TaskID } from "./schema"

export type Limits = {
  maxSubagents: number
  maxConcurrency: number
  maxReviewRounds: number
}

export type PlanValidation = {
  valid: boolean
  errors: string[]
}

export type ReadyBatch = {
  tasks: PlannedTask[]
  blocked: { task: PlannedTask; reason: string }[]
}

function taskID(value: string) {
  return value as TaskID
}

function taskLabel(task: Pick<PlannedTask, "id" | "title">) {
  return `${task.id} (${task.title})`
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []))
}

function balancedJsonObjects(value: string) {
  const candidates: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === "{") {
      if (depth === 0) start = index
      depth++
      continue
    }
    if (char !== "}") continue
    depth--
    if (depth === 0 && start >= 0) {
      candidates.push(value.slice(start, index + 1))
      start = -1
    }
  }
  return candidates
}

export function normalizePlan(value: unknown): Plan | undefined {
  const obj = record(value)
  const goal = text(obj?.goal)
  const rawTasks = obj?.tasks
  if (!goal || !Array.isArray(rawTasks)) return
  const tasks = rawTasks.flatMap((item): PlannedTask[] => {
    const task = record(item)
    if (!task) return []
    const title = text(task.title) ?? text(task.description)
    const id = text(task.id) ?? title
    const prompt = text(task.prompt)
    const role = text(task.role) ?? "general"
    const complexity = text(task.complexity) === "complex" ? "complex" : "simple"
    const model = text(task.model) ?? "-"
    if (!id || !title || !prompt) return []
    return [
      {
        id: taskID(id),
        step: Math.max(1, Math.trunc(number(task.step) ?? 1)),
        title,
        role: role as PlannedTask["role"],
        complexity,
        model,
        dependencies: stringList(task.dependencies).map(taskID),
        prompt,
        acceptanceCriteria: stringList(task.acceptanceCriteria),
        expectedArtifacts: stringList(task.expectedArtifacts),
      },
    ]
  })
  if (tasks.length === 0) return
  return { goal, tasks }
}

export function extractPlanFromText(value: string): Plan | undefined {
  const fenced = [...value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1] ?? "")
  for (const candidate of [...fenced, ...balancedJsonObjects(value)]) {
    try {
      const plan = normalizePlan(JSON.parse(candidate))
      if (plan) return plan
    } catch {
      // Keep scanning; model output often contains non-plan JSON nearby.
    }
  }
  return
}

export function validatePlan(plan: Plan, limits: Pick<Limits, "maxSubagents" | "maxConcurrency">): PlanValidation {
  const errors: string[] = []
  if (!plan.goal.trim()) errors.push("goal must be non-empty")
  if (plan.tasks.length === 0) errors.push("plan must include at least one task")
  if (plan.tasks.length > limits.maxSubagents) {
    errors.push(`plan has ${plan.tasks.length} tasks, exceeding max_subagents=${limits.maxSubagents}`)
  }

  const byID = new Map<string, PlannedTask>()
  for (const task of plan.tasks) {
    if (byID.has(task.id)) errors.push(`duplicate task id: ${task.id}`)
    byID.set(task.id, task)
    if (!Number.isInteger(task.step) || task.step < 1) {
      errors.push(`task ${taskLabel(task)} must have a positive integer step`)
    }
    if (!task.prompt.trim()) errors.push(`task ${taskLabel(task)} must include a prompt`)
    if (task.acceptanceCriteria.length === 0) {
      errors.push(`task ${taskLabel(task)} must include acceptance criteria`)
    }
  }

  const stepCounts = new Map<number, number>()
  for (const task of plan.tasks) {
    stepCounts.set(task.step, (stepCounts.get(task.step) ?? 0) + 1)
    for (const dependency of task.dependencies) {
      const dep = byID.get(dependency)
      if (!dep) {
        errors.push(`task ${taskLabel(task)} depends on unknown task ${dependency}`)
        continue
      }
      if (dep.id === task.id) {
        errors.push(`task ${taskLabel(task)} cannot depend on itself`)
        continue
      }
      if (dep.step >= task.step) {
        errors.push(
          `task ${taskLabel(task)} depends on ${taskLabel(dep)}, but dependencies must be in earlier steps`,
        )
      }
    }
  }

  for (const [step, count] of stepCounts) {
    if (count > limits.maxConcurrency) {
      errors.push(`step ${step} has ${count} tasks, exceeding max_concurrency=${limits.maxConcurrency}`)
    }
  }

  return { valid: errors.length === 0, errors }
}

export function nextReadyBatch(
  plan: Plan,
  state: {
    completed: Iterable<string>
    dispatched?: Iterable<string>
    failed?: Iterable<string>
  },
): ReadyBatch {
  const completed = new Set(state.completed)
  const dispatched = new Set(state.dispatched ?? [])
  const failed = new Set(state.failed ?? [])
  const tasks: PlannedTask[] = []
  const blocked: ReadyBatch["blocked"] = []

  for (const task of plan.tasks.toSorted((a, b) => a.step - b.step || a.id.localeCompare(b.id))) {
    if (completed.has(task.id) || dispatched.has(task.id) || failed.has(task.id)) continue
    const failedDependency = task.dependencies.find((dependency) => failed.has(dependency))
    if (failedDependency) {
      blocked.push({ task, reason: `dependency failed: ${failedDependency}` })
      continue
    }
    const missing = task.dependencies.filter((dependency) => !completed.has(dependency))
    if (missing.length > 0) {
      blocked.push({ task, reason: `waiting for dependencies: ${missing.join(", ")}` })
      continue
    }
    tasks.push(task)
  }

  return { tasks, blocked }
}

export function canRequestRevision(input: { roundsUsed: number; limits: Pick<Limits, "maxReviewRounds"> }) {
  return input.roundsUsed < input.limits.maxReviewRounds
}

export function coerceTaskID(value: string): TaskID {
  return taskID(value)
}
