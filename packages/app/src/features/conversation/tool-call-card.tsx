import type { ToolPart } from "@jyycode-ai/sdk/v2/client"
import { CircleCheck, CircleEllipsis, CircleX, LoaderCircle, Wrench } from "lucide-solid"
import { Match, Show, Switch } from "solid-js"
import { TaskActivity } from "./task-activity"

function statusLabel(status: ToolPart["state"]["status"]) {
  switch (status) {
    case "pending":
      return "等待执行"
    case "running":
      return "执行中"
    case "completed":
      return "已完成"
    case "error":
      return "执行失败"
  }
}

function duration(state: ToolPart["state"]) {
  if (state.status !== "completed" && state.status !== "error") return undefined
  const milliseconds = Math.max(0, state.time.end - state.time.start)
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(1)}s`
}

export function taskSessionID(part: ToolPart) {
  if (part.tool !== "task" || part.state.status === "pending") return undefined
  const sessionID = part.state.metadata?.sessionId
  return typeof sessionID === "string" ? sessionID : undefined
}

export function ToolCallCard(props: { part: ToolPart }) {
  const title = () =>
    (props.part.state.status === "running" || props.part.state.status === "completed") && props.part.state.title
      ? props.part.state.title
      : props.part.tool

  return (
    <section class="tool-call" data-status={props.part.state.status} aria-label={`工具调用：${props.part.tool}`}>
      <span class="tool-call__icon" aria-hidden="true">
        <Wrench />
      </span>
      <span class="tool-call__title">
        <strong>{title()}</strong>
        <Show when={title() !== props.part.tool}>
          <small>{props.part.tool}</small>
        </Show>
      </span>
      <span class="tool-call__status">
        <Switch>
          <Match when={props.part.state.status === "pending"}>
            <CircleEllipsis aria-hidden="true" />
          </Match>
          <Match when={props.part.state.status === "running"}>
            <LoaderCircle aria-hidden="true" />
          </Match>
          <Match when={props.part.state.status === "completed"}>
            <CircleCheck aria-hidden="true" />
          </Match>
          <Match when={props.part.state.status === "error"}>
            <CircleX aria-hidden="true" />
          </Match>
        </Switch>
        {statusLabel(props.part.state.status)}
        {duration(props.part.state) ? ` · ${duration(props.part.state)}` : ""}
      </span>
      <Show when={taskSessionID(props.part)}>
        {(sessionID) => <TaskActivity sessionID={sessionID()} running={props.part.state.status === "running"} />}
      </Show>
    </section>
  )
}
