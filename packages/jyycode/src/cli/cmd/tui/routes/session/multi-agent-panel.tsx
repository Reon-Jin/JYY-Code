import { createMemo, For, Show } from "solid-js"
import type { ToolPart } from "@jyycode-ai/sdk/v2"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { getScrollAcceleration } from "../../util/scroll"
import { Locale } from "@/util/locale"

type RowStatus = "queued" | "running" | "done" | "failed"

type Row = {
  index: number
  role: string
  model: string
  status: RowStatus
  task: string
  sessionID?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
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

function taskStatus(part: ToolPart, childStatus?: RowStatus) {
  if (part.state.status === "completed") return isBackgroundTask(part) ? (childStatus ?? "running") : "done"
  if (part.state.status === "error") return "failed"
  if (part.state.status === "running") return "running"
  return "queued"
}

function outputStatus(state: string): RowStatus | undefined {
  if (state === "completed") return "done"
  if (state === "running") return "running"
  if (state === "error" || state === "cancelled") return "failed"
}

function parseTaskOutputStatus(value: string) {
  const taskID = value.match(/^task_id:\s*(\S+)/m)?.[1]
  const state = value.match(/^state:\s*(\S+)/m)?.[1]
  const status = state ? outputStatus(state) : undefined
  if (!taskID || !status) return
  return { taskID, status }
}

export function MultiAgentPanel(props: { sessionID: string; enabled: boolean; disabled: boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const taskStatusByID = createMemo(() => {
    const out = new Map<string, RowStatus>()

    for (const message of messages()) {
      for (const part of sync.data.part[message.id] ?? []) {
        if (part.type !== "tool" || part.tool !== "task_status") {
          if (part.type === "text") {
            const parsed = parseTaskOutputStatus(part.text)
            if (parsed) out.set(parsed.taskID, parsed.status)
          }
          continue
        }

        const meta = metadata(part)
        const taskID = text(meta?.task_id)
        const state = text(meta?.state)
        const status = state ? outputStatus(state) : undefined
        if (taskID && status) out.set(taskID, status)
      }
    }

    return out
  })
  const childStatus = (sessionID: string | undefined): RowStatus | undefined => {
    if (!sessionID) {
      return
    }

    const explicit = taskStatusByID().get(sessionID)
    if (explicit) {
      return explicit
    }

    const sessionStatus = sync.data.session_status[sessionID]
    if (sessionStatus?.type === "busy" || sessionStatus?.type === "retry") {
      return "running"
    }

    const childMessages = sync.data.message[sessionID] ?? []
    const latestAssistant = childMessages.findLast((message) => message.role === "assistant")
    if (latestAssistant?.error) {
      return "failed"
    }
    if (
      latestAssistant?.time.completed &&
      latestAssistant.finish &&
      !["tool-calls", "unknown"].includes(latestAssistant.finish)
    ) {
      return "done"
    }
    if (childMessages.length > 0) {
      return "running"
    }

    return undefined
  }
  const rows = createMemo<Row[]>(() =>
    messages()
      .flatMap((message) =>
        (sync.data.part[message.id] ?? [])
          .filter((part): part is ToolPart => part.type === "tool" && part.tool === "task")
          .map((part) => {
            const sessionID = taskSessionID(part)
            return {
              role: Locale.titlecase(text(stateInput(part)?.subagent_type) ?? "general"),
              model: modelLabel(part),
              status: taskStatus(part, childStatus(sessionID)),
              task: Locale.truncate(text(stateInput(part)?.description) ?? text(stateInput(part)?.prompt) ?? "", 48),
              sessionID,
            }
          }),
      )
      .map((row, index) => ({ ...row, index: index + 1 })),
  )
  const active = createMemo(() => rows().some((row) => row.status === "running" || row.status === "queued"))
  const done = createMemo(() => rows().filter((row) => row.status === "done").length)
  const failed = createMemo(() => rows().filter((row) => row.status === "failed").length)
  const visibleRows = createMemo(() => Math.min(rows().length, 12))
  const status = createMemo(() => {
    if (props.disabled) return "disabled"
    if (!props.enabled && rows().length === 0) return "off"
    if (active()) return "dispatching"
    if (rows().length > 0) return "reviewing"
    return "idle"
  })

  return (
    <Show when={props.enabled || props.disabled || rows().length > 0}>
      <box flexDirection="column" gap={0} paddingLeft={1} paddingRight={1} paddingBottom={1}>
        <text fg={props.disabled ? theme.textMuted : props.enabled ? theme.success : theme.textMuted}>
          Multi-Agent {props.disabled ? "disabled" : props.enabled ? "●" : "○"}{" "}
          <span style={{ fg: theme.textMuted }}>
            main: {status()} agents: {rows().length} running:{" "}
            {rows().filter((row) => row.status === "running").length} done: {done()} failed: {failed()}
          </span>
        </text>
        <Show when={rows().length > 0}>
          <scrollbox
            height={visibleRows()}
            paddingLeft={1}
            scrollbarOptions={{ visible: false }}
            scrollAcceleration={scrollAcceleration()}
          >
            <For each={rows()}>
              {(row) => (
                <text fg={row.status === "failed" ? theme.error : row.status === "running" ? theme.warning : theme.text}>
                  <span style={{ fg: theme.textMuted }}>{String(row.index).padStart(2, " ")} </span>
                  {row.role.padEnd(10, " ").slice(0, 10)} {row.model.padEnd(24, " ").slice(0, 24)}{" "}
                  {row.status.padEnd(10, " ").slice(0, 10)} {row.task}
                </text>
              )}
            </For>
          </scrollbox>
        </Show>
      </box>
    </Show>
  )
}
