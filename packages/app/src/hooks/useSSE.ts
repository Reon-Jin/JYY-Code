import { createSignal, onCleanup } from "solid-js"
import { appendPartDelta, mergeMessageParts, toMessage } from "../api"
import { appActions, useAppState } from "../stores/app"
import { sessionActions } from "../stores/session"
import type { FileChange, Message, PermissionRequestPart, TaskPlan, TaskStep } from "../types/models"

type EventEnvelope = {
  id?: string
  type: string
  properties: Record<string, any>
}

type GlobalEnvelope = {
  directory?: string
  payload?: EventEnvelope
}

export function useSSE() {
  const appState = useAppState()
  const [connected, setConnected] = createSignal(false)
  let eventSource: EventSource | null = null
  let reconnectTimer: number | undefined

  function connect(sessionId: string) {
    if (!appState.baseUrl) return
    disconnect()

    const url = new URL("/global/event", appState.baseUrl)
    if (appState.activeWorkspaceDir) url.searchParams.set("directory", appState.activeWorkspaceDir)
    eventSource = new EventSource(url.toString())

    eventSource.onopen = () => setConnected(true)
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as EventEnvelope | GlobalEnvelope
        if ("directory" in data && data.directory && appState.activeWorkspaceDir && data.directory !== appState.activeWorkspaceDir) {
          return
        }
        handleEvent(("payload" in data && data.payload ? data.payload : data) as EventEnvelope, sessionId)
      } catch (err) {
        console.warn("SSE parse error:", err)
      }
    }
    eventSource.onerror = () => {
      setConnected(false)
      window.clearTimeout(reconnectTimer)
      reconnectTimer = window.setTimeout(() => connect(sessionId), 1500)
    }
  }

  function disconnect() {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    eventSource?.close()
    eventSource = null
    setConnected(false)
  }

  onCleanup(disconnect)
  return { connected, connect, disconnect }
}

function handleEvent(event: EventEnvelope, sessionId: string) {
  if (!event || !event.type) return
  const props = event.properties ?? {}
  const target = eventSessionID(event)
  if (target && target !== sessionId) return

  switch (event.type) {
    case "message.updated": {
      const info = props.info
      if (!info) return
      sessionActions.updateMessage(info.id, (current) => {
        const next = toMessage({ info, parts: current?.parts ? [] : [] } as any)
        return { ...next, parts: current?.parts ?? [] }
      })
      if (info.role === "assistant" && !info.time?.completed) {
        sessionActions.setStreamingMessageId(info.id)
        sessionActions.setSessionStatus("running")
      }
      if (info.role === "assistant" && info.time?.completed) {
        sessionActions.setStreamingMessageId(null)
        sessionActions.setSessionStatus(info.error ? "error" : "idle")
      }
      break
    }
    case "message.part.updated": {
      const part = props.part
      if (!part) return
      sessionActions.updateMessage(part.messageID, (current) => mergeMessageParts(current, part))
      if (part.type === "tool") updateTaskFromTool(part)
      break
    }
    case "message.part.delta": {
      if (props.field !== "text") return
      sessionActions.updateMessage(props.messageID, (current) =>
        appendPartDelta(current, { messageID: props.messageID, partID: props.partID, delta: props.delta }),
      )
      break
    }
    case "todo.updated":
      sessionActions.setTaskPlan(toTaskPlan(props.todos ?? []))
      break
    case "session.diff":
      sessionActions.setFileChanges((props.diff ?? []).map(toFileChange))
      break
    case "session.status": {
      const status = normalizeStatus(props.status)
      appActions.updateSession(props.sessionID, { status })
      sessionActions.setSessionStatus(status)
      if (status !== "running") sessionActions.setStreamingMessageId(null)
      break
    }
    case "session.updated": {
      const info = props.info ?? {}
      const status = info.time?.compacting ? "running" : "idle"
      appActions.updateSession(props.sessionID, {
        title: info.title,
        model: info.model ? `${info.model.providerID}/${info.model.id ?? info.model.modelID}${info.model.variant ? `::${info.model.variant}` : ""}` : undefined,
        agent: info.agent,
        multiAgent: info.multiAgent ?? undefined,
        permission: info.permission ?? undefined,
        status,
        updatedAt: info.time?.updated,
      })
      break
    }
    case "permission.asked": {
      const part: PermissionRequestPart = {
        id: props.id,
        type: "permission_request",
        toolName: props.permission ?? "tool",
        message: permissionMessage(props),
        status: "pending",
        patterns: props.patterns,
        always: props.always,
        metadata: props.metadata,
      }
      const messageID = props.tool?.messageID ?? `permission-${props.id}`
      sessionActions.updateMessagePart(messageID, part)
      break
    }
    case "permission.replied": {
      const requestID = props.requestID
      if (!requestID) return
      sessionActions.updatePermissionStatus(requestID, props.reply === "reject" ? "denied" : "approved")
      break
    }
    case "session.error":
      sessionActions.setSessionStatus("error")
      sessionActions.setStreamingMessageId(null)
      break
  }
}

function permissionMessage(props: Record<string, any>) {
  const patterns = Array.isArray(props.patterns) ? props.patterns.filter((item) => typeof item === "string") : []
  if (patterns.length === 0) return "Permission required"
  if (patterns.length === 1) return patterns[0]
  return patterns.join(", ")
}

function eventSessionID(event: EventEnvelope) {
  const props = event.properties ?? {}
  if (typeof props.sessionID === "string") return props.sessionID
  if (props.info?.sessionID) return props.info.sessionID as string
  if (props.part?.sessionID) return props.part.sessionID as string
  return undefined
}

function normalizeStatus(status: any): "idle" | "running" | "error" {
  const value = typeof status === "string" ? status : status?.type
  if (value === "idle") return "idle"
  if (value === "error") return "error"
  return "running"
}

function updateTaskFromTool(part: any) {
  if (part.tool !== "task" && part.tool !== "task_status") return
  const input = part.state?.input ?? {}
  const title = input.description ?? input.prompt ?? input.task_id ?? part.tool
  const status = part.state?.status === "completed" ? "completed" : part.state?.status === "error" ? "failed" : "running"
  const step: TaskStep = {
    id: part.callID ?? part.id,
    title: String(title),
    status,
    detail: input.subagent_type ? `Agent: ${input.subagent_type}` : undefined,
  }
  sessionActions.setTaskPlan({
    steps: [step],
    currentStepIndex: status === "completed" ? 0 : 0,
    totalSteps: 1,
  })
}

function toTaskPlan(todos: Array<{ content: string; status: string; priority?: string }>): TaskPlan | null {
  if (!todos.length) return null
  const steps: TaskStep[] = todos.map((todo, index) => ({
    id: `${index}-${todo.content}`,
    title: todo.content,
    status:
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress"
          ? "running"
          : todo.status === "cancelled"
            ? "failed"
            : "pending",
    detail: todo.priority ? `Priority: ${todo.priority}` : undefined,
  }))
  const currentStepIndex = Math.max(
    0,
    steps.findIndex((step) => step.status === "running" || step.status === "pending"),
  )
  return { steps, currentStepIndex, totalSteps: steps.length }
}

function toFileChange(diff: any): FileChange {
  return {
    filePath: diff.file ?? "unknown",
    status: diff.status ?? "modified",
    additions: diff.additions ?? 0,
    deletions: diff.deletions ?? 0,
    hunks: [],
    patch: diff.patch,
  }
}
