export * as AgentClusterRuntime from "./runtime"

import type { Plan, PlannedTask, TaskID, TaskStatus } from "./schema"

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

export type PersistedTaskState = {
  id: TaskID | string
  step: number
  status: TaskStatus
  resultSummary?: string | null
  reviewIssues?: string[] | null
}

export type StepGateResult = {
  allowed: boolean
  pending: string[]
  rejected: string[]
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

function resolveRole(raw: string): PlannedTask["role"] {
  const lower = raw.toLowerCase()
  if (lower.includes("research") || lower.includes("调研")) return "researcher"
  if (lower.includes("search") || lower.includes("图片") || lower.includes("image") || lower.includes("picture"))
    return "researcher"
  if (lower.includes("analyst") || lower.includes("analysis") || lower.includes("分析")) return "analyst"
  if (lower.includes("write") || lower.includes("writer") || lower.includes("写")) return "writer"
  if (lower.includes("chart") || lower.includes("图表")) return "chart"
  if (
    lower.includes("pdf") ||
    lower.includes("word") ||
    lower.includes("doc") ||
    lower.includes("excel") ||
    lower.includes("xlsx") ||
    lower.includes("spreadsheet") ||
    lower.includes("workbook") ||
    lower.includes("powerpoint") ||
    lower.includes("ppt") ||
    lower.includes("office") ||
    lower.includes("文档") ||
    lower.includes("表格") ||
    lower.includes("演示") ||
    lower.includes("幻灯片")
  )
    return "office"
  if (lower.includes("test") || lower.includes("测试") || lower.includes("验证")) return "tester"
  if (
    lower.includes("code") ||
    lower.includes("coder") ||
    lower.includes("开发") ||
    lower.includes("代码") ||
    lower.includes("前端") ||
    lower.includes("html") ||
    lower.includes("css") ||
    lower.includes("js") ||
    lower.includes("javascript")
  )
    return "coder"
  return "general"
}

export function normalizePlan(value: unknown): Plan | undefined {
  const obj = record(value)
  // Allow project, description as fallback goal field names
  const goal = text(obj?.goal) ?? text(obj?.project) ?? text(obj?.description) ?? ""
  const cancelTaskIDs = stringList(obj?.cancelTaskIDs ?? obj?.cancel_task_ids).map(taskID)
  // Support both top-level tasks and nested steps[].tasks[]
  let rawTasks = obj?.tasks
  if (!Array.isArray(rawTasks)) {
    const steps = obj?.steps
    if (Array.isArray(steps)) {
      rawTasks = steps.flatMap((step: unknown) => {
        const s = record(step)
        const tasks = Array.isArray(s?.tasks) ? (s!.tasks as unknown[]) : []
        // Propagate parent step number to child tasks that lack their own step
        const parentStep = Math.trunc(number(s?.step) ?? 1)
        return tasks.map((t: unknown) => {
          const task = record(t)
          if (task && task.step === undefined) {
            return { ...task, step: parentStep }
          }
          return t
        })
      })
    }
  }
  if (!Array.isArray(rawTasks)) return
  const tasks = rawTasks.flatMap((item): PlannedTask[] => {
    const task = record(item)
    if (!task) return []
    const title = text(task.title) ?? text(task.description)
    const id = text(task.id) ?? title
    // Support common alternative field names for prompt
    const prompt = text(task.prompt) ?? text(task.detailed_prompt) ?? text(task.instruction)
    const role = resolveRole(text(task.role) ?? "general")
    const complexity = text(task.complexity) === "complex" ? "complex" : "simple"
    const model = text(task.model) ?? "-"
    if (!id || !title || !prompt) return []
    // Support both camelCase and snake_case field names
    const acceptanceCriteria =
      stringList(task.acceptanceCriteria).length > 0
        ? stringList(task.acceptanceCriteria)
        : stringList(task.acceptance_criteria)
    const expectedArtifacts =
      stringList(task.expectedArtifacts).length > 0
        ? stringList(task.expectedArtifacts)
        : stringList(task.expected_artifacts).length > 0
          ? stringList(task.expected_artifacts)
          : stringList(task.expected_artifact_paths).length > 0
            ? stringList(task.expected_artifact_paths)
            : typeof task.expected_artifact === "string" && task.expected_artifact.trim()
              ? [task.expected_artifact.trim()]
              : []
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
        acceptanceCriteria,
        expectedArtifacts,
      },
    ]
  })
  if (tasks.length === 0 && cancelTaskIDs.length === 0) return
  return { goal: goal || "Multi-Agent cluster run", tasks, ...(cancelTaskIDs.length ? { cancelTaskIDs } : {}) }
}

// JSON.parse is strict; LLMs often produce trailing commas.
function stripTrailingCommas(json: string): string {
  return json.replace(/,(\s*[}\]])/g, "$1")
}

// LLM-generated plans occasionally contain quoted UI copy inside a JSON
// string without escaping it, for example: `"prompt": "show "+100""`.
// A quote can close a JSON string only when the next non-whitespace character
// is a structural delimiter. Escape other quotes so the complete plan can
// still pass through the normal schema validation below.
function repairUnescapedStringQuotes(json: string): string {
  let result = ""
  let inString = false
  let escaped = false

  for (let index = 0; index < json.length; index++) {
    const char = json[index]!
    if (!inString) {
      result += char
      if (char === '"') inString = true
      continue
    }
    if (escaped) {
      result += char
      escaped = false
      continue
    }
    if (char === "\\") {
      result += char
      escaped = true
      continue
    }
    if (char !== '"') {
      result += char
      continue
    }

    let next = index + 1
    while (next < json.length && /\s/.test(json[next]!)) next++
    if (next >= json.length || [":", ",", "}", "]"].includes(json[next]!)) {
      result += char
      inString = false
      continue
    }
    result += '\\"'
  }

  return result
}

function tryJsonParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    const withoutTrailingCommas = stripTrailingCommas(text)
    try {
      return JSON.parse(withoutTrailingCommas)
    } catch {
      try {
        return JSON.parse(repairUnescapedStringQuotes(withoutTrailingCommas))
      } catch {
        return undefined
      }
    }
  }
}

export function extractPlanFromText(value: string): Plan | undefined {
  const fenced = [...value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1] ?? "")
  for (const candidate of [...fenced, ...balancedJsonObjects(value)]) {
    const parsed = tryJsonParse(candidate)
    if (parsed) {
      const plan = normalizePlan(parsed)
      if (plan) return plan
    }
  }
  return
}

export function validatePlan(plan: Plan, limits: Pick<Limits, "maxSubagents" | "maxConcurrency">): PlanValidation {
  const errors: string[] = []
  if (!plan.goal.trim()) errors.push("goal must be non-empty")
  if (plan.tasks.length === 0 && plan.cancelTaskIDs?.length === 0) errors.push("plan must include at least one task")
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

  // Collect all validation errors.  Fundamental errors (duplicates, unknown
  // dependencies, self-references) prevent auto-fix from running, but we
  // still report them all.
  let hasFundamentalError = errors.length > 0
  for (const task of plan.tasks) {
    for (const dependency of task.dependencies) {
      const dep = byID.get(dependency)
      if (!dep) {
        errors.push(`task ${taskLabel(task)} depends on unknown task ${dependency}`)
        hasFundamentalError = true
        continue
      }
      if (dep.id === task.id) {
        errors.push(`task ${taskLabel(task)} cannot depend on itself`)
        hasFundamentalError = true
        continue
      }
      // Same-step dependency — this is auto-fixable, but if there are also
      // fundamental errors we'll report it right here.
      if (hasFundamentalError && dep.step >= task.step) {
        errors.push(`task ${taskLabel(task)} depends on ${taskLabel(dep)}, but dependencies must be in earlier steps`)
      }
    }
  }

  // Auto-fix: compute each task's minimum required step from the dependency
  // DAG.  LLMs often put dependent tasks in the same step by accident.  Skip
  // auto-fix when fundamental errors exist.
  const override = new Map<string, number>()
  if (!hasFundamentalError) {
    let rerun = true
    while (rerun) {
      rerun = false
      for (const task of plan.tasks) {
        for (const depID of task.dependencies) {
          const dep = byID.get(depID)
          if (!dep || dep.id === task.id) continue
          const curStep = override.get(task.id) ?? task.step
          const depStep = override.get(dep.id) ?? dep.step
          const minStep = depStep + 1
          if (curStep < minStep) {
            override.set(task.id, minStep)
            rerun = true
          }
        }
      }
    }
  }

  // Phase 3: full validation using corrected steps.
  const stepCounts = new Map<number, number>()
  for (const task of plan.tasks) {
    const step = Math.max(override.get(task.id) ?? task.step, 1)
    stepCounts.set(step, (stepCounts.get(step) ?? 0) + 1)
    for (const dependency of task.dependencies) {
      const dep = byID.get(dependency)
      if (!dep || dep.id === task.id) continue
      const depStep = override.get(dep.id) ?? dep.step
      if (depStep >= step) {
        errors.push(
          `task ${taskLabel(task)} depends on ${taskLabel(dep)} (step ${depStep}), ` +
            `but ${taskLabel(task)} is at step ${step} which must be > ${depStep}. ` +
            `Move ${task.id} to step ${depStep + 1} or later.`,
        )
      }
    }
  }

  for (const [step, count] of stepCounts) {
    if (count > limits.maxConcurrency) {
      errors.push(`step ${step} has ${count} tasks, exceeding max_concurrency=${limits.maxConcurrency}`)
    }
  }

  const artifactsByStep = new Map<string, PlannedTask>()
  for (const task of plan.tasks) {
    for (const artifact of task.expectedArtifacts) {
      const normalized = artifact.trim()
      if (!normalized) continue
      const step = override.get(task.id) ?? task.step
      const key = `${step}\0${normalized}`
      const existing = artifactsByStep.get(key)
      if (existing) {
        errors.push(`step ${step} has duplicate expected artifact ${normalized}: ${existing.id} and ${task.id}`)
        continue
      }
      artifactsByStep.set(key, task)
    }
  }

  // Apply overrides back so downstream code (persistPlan, stepGate) sees the
  // corrected steps.
  for (const [id, step] of override) {
    const task = byID.get(id)
    if (task) (task as { step: number }).step = step
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
  const candidates = plan.tasks
    .filter((task) => !completed.has(task.id) && !dispatched.has(task.id) && !failed.has(task.id))
    .toSorted((a, b) => a.step - b.step || a.id.localeCompare(b.id))
  const targetStep = candidates[0]?.step
  const tasks: PlannedTask[] = []
  const blocked: ReadyBatch["blocked"] = []

  for (const task of candidates) {
    if (targetStep !== undefined && task.step > targetStep) {
      blocked.push({ task, reason: `waiting for earlier step ${targetStep}` })
      continue
    }
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

export function stepGate(tasks: Iterable<PersistedTaskState>, targetStep: number): StepGateResult {
  const pending: string[] = []
  const rejected: string[] = []
  for (const task of tasks) {
    if (task.step >= targetStep) continue
    if (task.status === "accepted") continue
    if (task.status === "failed" || task.status === "cancelled") {
      rejected.push(String(task.id))
      continue
    }
    pending.push(String(task.id))
  }
  pending.sort()
  rejected.sort()
  return { allowed: pending.length === 0 && rejected.length === 0, pending, rejected }
}

export function canSynthesize(tasks: Iterable<PersistedTaskState>) {
  return [...tasks].every((task) => task.status === "accepted")
}

export function canRequestRevision(input: { roundsUsed: number; limits: Pick<Limits, "maxReviewRounds"> }) {
  return input.roundsUsed < input.limits.maxReviewRounds
}

export function coerceTaskID(value: string): TaskID {
  return taskID(value)
}
