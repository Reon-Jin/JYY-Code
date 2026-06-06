import type { AssistantMessage, Message, Part, ToolPart } from "@jyycode-ai/sdk/v2"

export type AgentClusterTaskStatus = "queued" | "running" | "done" | "failed"

export type AgentClusterPlanTask = {
  id: string
  step: number
  title: string
  role: string
  complexity?: string
  model: string
  dependencies: string[]
  acceptanceCriteria: string[]
  expectedArtifacts: string[]
  status: AgentClusterTaskStatus
}

export type AgentClusterPlan = {
  goal: string
  tasks: AgentClusterPlanTask[]
  partial?: boolean
}

export type AgentClusterStep = {
  index: number
  tasks: AgentClusterPlanTask[]
  agents: number
  done: number
  running: number
  failed: number
  status: AgentClusterTaskStatus
}

export type AgentClusterTaskRun = {
  index: number
  id?: string
  role: string
  model: string
  status: AgentClusterTaskStatus
  task: string
  sessionID?: string
}

export type AgentClusterSnapshot = {
  visible: boolean
  status: "disabled" | "off" | "planning" | "dispatching" | "reviewing" | "completed"
  plan?: AgentClusterPlan
  steps: AgentClusterStep[]
  rows: AgentClusterTaskRun[]
  totalSteps: number
  completedSteps: number
  currentStep?: number
  totalAgents: number
  runningAgents: number
  doneAgents: number
  failedAgents: number
}

type JsonCandidate = {
  start: number
  end: number
  json: string
}

type SessionStatusLike = {
  type?: string
}

type SnapshotInput = {
  sessionID: string
  enabled: boolean
  disabled: boolean
  messages: (sessionID: string) => readonly Message[]
  parts: (messageID: string) => readonly Part[]
  sessionStatus?: (sessionID: string) => SessionStatusLike | undefined
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

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/\s+/g, "")
}

function isClusterAssistant(message: Message): message is AssistantMessage {
  return message.role === "assistant" && (message.agent === "cluster" || message.mode === "cluster")
}

function stateInput(part: ToolPart) {
  return "input" in part.state ? record(part.state.input) : undefined
}

function stateMetadata(part: ToolPart) {
  return "metadata" in part.state ? record(part.state.metadata) : undefined
}

function metadata(part: ToolPart) {
  return stateMetadata(part) ?? record(Reflect.get(part, "metadata"))
}

function taskSessionID(part: ToolPart) {
  return text(metadata(part)?.sessionId) ?? text(metadata(part)?.sessionID)
}

function isBackgroundTask(part: ToolPart) {
  return metadata(part)?.background === true
}

function modelLabel(part: ToolPart) {
  const model = metadata(part)?.model
  if (record(model)) {
    const providerID = text(record(model)?.providerID)
    const modelID = text(record(model)?.modelID)
    if (providerID && modelID) return `${providerID}/${modelID}`
  }
  return text(stateInput(part)?.model) ?? "-"
}

function outputStatus(state: string): AgentClusterTaskStatus | undefined {
  if (state === "completed") return "done"
  if (state === "running") return "running"
  if (state === "error" || state === "cancelled") return "failed"
}

function taskStatus(part: ToolPart, childStatus?: AgentClusterTaskStatus) {
  if (part.state.status === "completed") return isBackgroundTask(part) ? (childStatus ?? "running") : "done"
  if (part.state.status === "error") return "failed"
  if (part.state.status === "running") return "running"
  return "queued"
}

function parseTaskOutputStatus(value: string) {
  const taskID = value.match(/^task_id:\s*(\S+)/m)?.[1]
  const state = value.match(/^state:\s*(\S+)/m)?.[1]
  const status = state ? outputStatus(state) : undefined
  if (!taskID || !status) return
  return { taskID, status }
}

function normalizePlanTask(item: unknown): AgentClusterPlanTask[] {
  const task = record(item)
  if (!task) return []

  const title = text(task.title) ?? text(task.description)
  const id = text(task.id) ?? title
  if (!title || !id) return []

  return [
    {
      id,
      step: Math.max(1, Math.trunc(number(task.step) ?? 1)),
      title,
      role: text(task.role) ?? "general",
      complexity: text(task.complexity),
      model: text(task.model) ?? "-",
      dependencies: stringList(task.dependencies),
      acceptanceCriteria: stringList(task.acceptanceCriteria),
      expectedArtifacts: stringList(task.expectedArtifacts),
      status: "queued",
    },
  ]
}

function normalizePlan(value: unknown): AgentClusterPlan | undefined {
  const obj = record(value)
  const goal = text(obj?.goal)
  const rawTasks = obj?.tasks
  if (!goal || !Array.isArray(rawTasks)) return

  const tasks = rawTasks.flatMap(normalizePlanTask)

  if (tasks.length === 0) return
  return { goal, tasks }
}

function parsePlanJson(json: string): AgentClusterPlan | undefined {
  try {
    return normalizePlan(JSON.parse(json))
  } catch {
    try {
      return normalizePlan(JSON.parse(repairInvalidJsonEscapes(json)))
    } catch {
      return
    }
  }
}

function repairInvalidJsonEscapes(json: string) {
  return json.replace(/\\+(?=[^"\\/bfnrtu])/g, (slashes) => (slashes.length % 2 === 0 ? slashes : slashes + "\\"))
}

function parseJsonStringLiteral(value: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = value.match(new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s"))
  if (!match) return undefined
  try {
    const parsed = JSON.parse(`"${match[1]}"`)
    return typeof parsed === "string" ? parsed : undefined
  } catch {
    return match[1]?.replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
}

function completedObjectsInArray(value: string, arrayStart: number) {
  const objects: string[] = []
  let objectStart = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = arrayStart; index < value.length; index++) {
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
    if (char === "]" && depth === 0) break
    if (char !== "{" && depth === 0) continue

    if (char === "{") {
      if (depth === 0) objectStart = index
      depth++
      continue
    }
    if (char !== "}") continue

    depth--
    if (depth === 0 && objectStart !== -1) {
      objects.push(value.slice(objectStart, index + 1))
      objectStart = -1
    }
  }

  return objects
}

function parsePartialPlanJson(value: string): AgentClusterPlan | undefined {
  const jsonStart = value.indexOf("{")
  if (jsonStart === -1) return undefined

  const json = value.slice(jsonStart)
  const tasksMatch = /"tasks"\s*:\s*\[/.exec(json)
  if (!tasksMatch) return undefined

  const goal = parseJsonStringLiteral(json, "goal") ?? ""
  const objectJsons = completedObjectsInArray(json, (tasksMatch.index ?? 0) + tasksMatch[0].length)
  const tasks = objectJsons.flatMap((taskJson) => {
    try {
      return normalizePlanTask(JSON.parse(taskJson))
    } catch {
      try {
        return normalizePlanTask(JSON.parse(repairInvalidJsonEscapes(taskJson)))
      } catch {
        return []
      }
    }
  })

  if (tasks.length === 0) return undefined
  return { goal, tasks, partial: true }
}

function collectJsonCandidates(textValue: string): JsonCandidate[] {
  const candidates: JsonCandidate[] = []
  const fence = /```[^\n`]*\n?([\s\S]*?)```/g
  for (const match of textValue.matchAll(fence)) {
    const raw = match[1]?.trim()
    if (!raw) continue
    candidates.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      json: raw,
    })
  }

  for (let start = 0; start < textValue.length; start++) {
    if (textValue[start] !== "{") continue

    let depth = 0
    let inString = false
    let escaped = false

    for (let index = start; index < textValue.length; index++) {
      const char = textValue[index]

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
      if (char === "{") depth++
      if (char === "}") depth--
      if (depth === 0) {
        const json = textValue.slice(start, index + 1)
        if (json.includes('"tasks"') || json.includes('"goal"')) {
          candidates.push({ start, end: index + 1, json })
        }
        break
      }
    }
  }

  return candidates
}

function collectPlanRanges(textValue: string) {
  const ranges = collectJsonCandidates(textValue)
    .flatMap((candidate) => {
      const plan = parsePlanJson(candidate.json)
      return plan ? [{ ...candidate, plan }] : []
    })
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))

  const accepted: typeof ranges = []
  for (const range of ranges) {
    const overlap = accepted.findIndex((item) => range.start < item.end && range.end > item.start)
    if (overlap === -1) {
      accepted.push(range)
      continue
    }
    const current = accepted[overlap]!
    if (range.end - range.start > current.end - current.start) {
      accepted[overlap] = range
    }
  }

  return accepted.sort((a, b) => a.start - b.start)
}

function looksLikePartialPlan(value: string) {
  return /\{\s*(?:"goal"|"tasks")\s*:/.test(value) || /"goal"\s*:/.test(value) || /"tasks"\s*:/.test(value)
}

function collectPartialPlanRange(textValue: string): JsonCandidate | undefined {
  const fenceStart = textValue.search(/```(?:json|jsonc|agent[_-]?cluster[_-]?plan)?\s*(?:\r?\n)?\s*\{[\s\S]*$/i)
  if (fenceStart !== -1) {
    const suffix = textValue.slice(fenceStart)
    if (looksLikePartialPlan(suffix)) return { start: fenceStart, end: textValue.length, json: suffix }
  }

  for (let start = 0; start < textValue.length; start++) {
    if (textValue[start] !== "{") continue
    const suffix = textValue.slice(start)
    if (looksLikePartialPlan(suffix)) return { start, end: textValue.length, json: suffix }
  }
}

function trimPlanOnlyPreamble(value: string) {
  const cleaned = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
  if (!cleaned) return ""
  if (cleaned.length > 180) return value.trim()
  if (/(plan|json|任务|计划|执行|开始|阶段|步骤|agent|subagent)/i.test(cleaned)) return ""
  return value.trim()
}

export function extractAgentClusterPlan(textValue: string): AgentClusterPlan | undefined {
  return collectPlanRanges(textValue).at(-1)?.plan ?? parsePartialPlanJson(collectPartialPlanRange(textValue)?.json ?? "")
}

export function stripAgentClusterPlanText(textValue: string): string {
  const ranges = collectPlanRanges(textValue)
  const partial = ranges.length === 0 ? collectPartialPlanRange(textValue) : undefined
  const removable = partial ? [partial] : ranges
  if (removable.length === 0) return textValue.trim()

  let result = textValue
  for (const range of [...removable].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, range.start) + result.slice(range.end)
  }

  return trimPlanOnlyPreamble(result.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n"))
}

function childStatus(
  input: SnapshotInput,
  sessionID: string | undefined,
  statuses: Map<string, AgentClusterTaskStatus>,
): AgentClusterTaskStatus | undefined {
  if (!sessionID) return

  const explicit = statuses.get(sessionID)
  if (explicit) return explicit

  const sessionStatus = input.sessionStatus?.(sessionID)
  if (sessionStatus?.type === "busy" || sessionStatus?.type === "retry") return "running"

  const childMessages = input.messages(sessionID)
  const latestAssistant = childMessages.findLast((message) => message.role === "assistant") as
    | AssistantMessage
    | undefined
  if (latestAssistant?.error) return "failed"
  if (
    latestAssistant?.time.completed &&
    latestAssistant.finish &&
    !["tool-calls", "unknown"].includes(latestAssistant.finish)
  ) {
    return "done"
  }
  if (childMessages.length > 0) return "running"
}

function latestPlan(input: SnapshotInput) {
  let plan: AgentClusterPlan | undefined
  for (const message of input.messages(input.sessionID)) {
    if (!isClusterAssistant(message)) continue
    for (const part of input.parts(message.id)) {
      if (part.type !== "text") continue
      plan = extractAgentClusterPlan(part.text) ?? plan
    }
  }
  return plan
}

function taskRuns(input: SnapshotInput, statuses: Map<string, AgentClusterTaskStatus>) {
  return input
    .messages(input.sessionID)
    .flatMap((message) =>
      input
        .parts(message.id)
        .filter((part): part is ToolPart => part.type === "tool" && part.tool === "task")
        .map((part) => {
          const sessionID = taskSessionID(part)
          const state = stateInput(part)
          return {
            id: text(state?.task_id),
            role: text(state?.subagent_type) ?? "general",
            model: modelLabel(part),
            status: taskStatus(part, childStatus(input, sessionID, statuses)),
            task: text(state?.description) ?? text(state?.prompt) ?? "",
            sessionID,
          }
        }),
    )
    .map((row, index) => ({ ...row, index: index + 1 }))
}

function explicitTaskStatus(input: SnapshotInput) {
  const out = new Map<string, AgentClusterTaskStatus>()
  const setStatus = (taskID: string, status: AgentClusterTaskStatus) => {
    const current = out.get(taskID)
    if ((current === "done" || current === "failed") && status === "running") return
    out.set(taskID, status)
  }
  const setFromText = (value: string | undefined) => {
    if (!value) return
    const parsed = parseTaskOutputStatus(value)
    if (parsed) setStatus(parsed.taskID, parsed.status)
  }

  for (const message of input.messages(input.sessionID)) {
    for (const part of input.parts(message.id)) {
      if (part.type === "text") {
        setFromText(part.text)
        continue
      }

      if (part.type !== "tool") continue
      if (part.state.status === "completed" && part.tool === "task_status") setFromText(part.state.output)
      if (part.tool !== "task_status") continue
      const meta = metadata(part)
      const taskID = text(meta?.task_id)
      const state = text(meta?.state)
      const status = state ? outputStatus(state) : undefined
      if (taskID && status) setStatus(taskID, status)
    }
  }

  return out
}

function mergePlanStatus(
  plan: AgentClusterPlan,
  rows: AgentClusterTaskRun[],
  statuses: Map<string, AgentClusterTaskStatus>,
) {
  const byID = new Map<string, AgentClusterTaskStatus>()
  const byTitle = new Map<string, AgentClusterTaskStatus>()

  for (const row of rows) {
    if (row.sessionID) byID.set(row.sessionID, row.status)
    if (row.id) byID.set(row.id, row.status)
    if (row.task) byTitle.set(normalizeKey(row.task), row.status)
  }
  for (const [id, status] of statuses) byID.set(id, status)

  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      status: byID.get(task.id) ?? byTitle.get(normalizeKey(task.title)) ?? "queued",
    })),
  }
}

function buildSteps(plan: AgentClusterPlan | undefined): AgentClusterStep[] {
  if (!plan) return []
  const byStep = new Map<number, AgentClusterPlanTask[]>()
  for (const task of plan.tasks) {
    const list = byStep.get(task.step) ?? []
    list.push(task)
    byStep.set(task.step, list)
  }

  return [...byStep.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, tasks]) => {
      const done = tasks.filter((task) => task.status === "done").length
      const running = tasks.filter((task) => task.status === "running").length
      const failed = tasks.filter((task) => task.status === "failed").length
      const status: AgentClusterTaskStatus =
        failed > 0
          ? "failed"
          : running > 0
            ? "running"
            : done === tasks.length
              ? "done"
              : tasks.some((task) => task.status === "done")
                ? "running"
                : "queued"

      return {
        index,
        tasks,
        agents: tasks.length,
        done,
        running,
        failed,
        status,
      }
    })
}

export function agentClusterSnapshot(input: SnapshotInput): AgentClusterSnapshot {
  const statuses = explicitTaskStatus(input)
  const rows = taskRuns(input, statuses)
  const plan = latestPlan(input)
  const planWithStatus = plan ? mergePlanStatus(plan, rows, statuses) : undefined
  const steps = buildSteps(planWithStatus)
  const taskSource = planWithStatus?.tasks ?? rows
  const runningAgents = taskSource.filter((task) => task.status === "running").length
  const doneAgents = taskSource.filter((task) => task.status === "done").length
  const failedAgents = taskSource.filter((task) => task.status === "failed").length
  const active = taskSource.some((task) => task.status === "running" || task.status === "queued")
  const currentStep =
    steps.find((step) => step.status === "running")?.index ?? steps.find((step) => step.status === "queued")?.index
  const completedSteps = steps.filter((step) => step.status === "done").length
  const status: AgentClusterSnapshot["status"] = input.disabled
    ? "disabled"
    : !input.enabled && rows.length === 0 && !planWithStatus
      ? "off"
      : !planWithStatus && rows.length === 0
        ? "planning"
        : planWithStatus?.partial && rows.length === 0
          ? "planning"
        : active
          ? "dispatching"
          : rows.length > 0 || planWithStatus
            ? completedSteps === steps.length && steps.length > 0
              ? "completed"
              : "reviewing"
            : "planning"

  return {
    visible: input.enabled || input.disabled || rows.length > 0 || !!planWithStatus,
    status,
    plan: planWithStatus,
    steps,
    rows,
    totalSteps: steps.length,
    completedSteps,
    currentStep,
    totalAgents: taskSource.length,
    runningAgents,
    doneAgents,
    failedAgents,
  }
}
