import { createMemo, For, Show } from "solid-js"
import type { ToolPart } from "@jyycode-ai/sdk/v2"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { Locale } from "@/util/locale"

type Row = {
  index: number
  role: string
  model: string
  status: string
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

function modelLabel(part: ToolPart) {
  const model = metadata(part)?.model
  if (record(model)) {
    const providerID = text(record(model)?.providerID)
    const modelID = text(record(model)?.modelID)
    if (providerID && modelID) return `${providerID}/${modelID}`
  }
  return text(stateInput(part)?.model) ?? "-"
}

function taskStatus(part: ToolPart) {
  if (part.state.status === "completed") return "submitted"
  if (part.state.status === "error") return "failed"
  if (part.state.status === "running") return "running"
  return "queued"
}

export function MultiAgentPanel(props: { sessionID: string; enabled: boolean; disabled: boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const rows = createMemo<Row[]>(() =>
    messages()
      .flatMap((message) =>
        (sync.data.part[message.id] ?? [])
          .filter((part): part is ToolPart => part.type === "tool" && part.tool === "task")
          .map((part, index) => ({
            index: index + 1,
            role: Locale.titlecase(text(stateInput(part)?.subagent_type) ?? "general"),
            model: modelLabel(part),
            status: taskStatus(part),
            task: Locale.truncate(text(stateInput(part)?.description) ?? text(stateInput(part)?.prompt) ?? "", 48),
            sessionID: taskSessionID(part),
          })),
      )
      .slice(-12),
  )
  const active = createMemo(() => rows().some((row) => row.status === "running" || row.status === "queued"))
  const done = createMemo(() => rows().filter((row) => row.status === "submitted").length)
  const failed = createMemo(() => rows().filter((row) => row.status === "failed").length)
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
          <box flexDirection="column" paddingLeft={1}>
            <For each={rows()}>
              {(row) => (
                <text fg={row.status === "failed" ? theme.error : row.status === "running" ? theme.warning : theme.text}>
                  <span style={{ fg: theme.textMuted }}>{String(row.index).padStart(2, " ")} </span>
                  {row.role.padEnd(10, " ").slice(0, 10)} {row.model.padEnd(24, " ").slice(0, 24)}{" "}
                  {row.status.padEnd(10, " ").slice(0, 10)} {row.task}
                </text>
              )}
            </For>
          </box>
        </Show>
      </box>
    </Show>
  )
}
