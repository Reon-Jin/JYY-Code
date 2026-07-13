import type { ToolPart } from "@jyycode-ai/sdk/v2/client"
import { CircleCheck, CircleEllipsis, CircleX, LoaderCircle, Wrench } from "lucide-solid"
import { Match, Switch } from "solid-js"

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

function payload(state: ToolPart["state"]) {
  const detail: Record<string, unknown> = { input: state.input }
  if (state.status === "pending") detail.raw = state.raw
  if (state.status === "completed") detail.output = state.output
  if (state.status === "error") detail.error = state.error
  return JSON.stringify(detail, null, 2)
}

export function ToolCallCard(props: { part: ToolPart }) {
  const title = () =>
    (props.part.state.status === "running" || props.part.state.status === "completed") && props.part.state.title
      ? props.part.state.title
      : props.part.tool

  return (
    <section class="tool-call" data-status={props.part.state.status} aria-label={`工具调用：${props.part.tool}`}>
      <header class="tool-call__header">
        <span class="tool-call__icon" aria-hidden="true">
          <Wrench />
        </span>
        <span class="tool-call__title">
          <strong>{title()}</strong>
          <small>{props.part.tool}</small>
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
      </header>
      <details class="tool-call__details">
        <summary>查看工具详情</summary>
        <pre>{payload(props.part.state)}</pre>
      </details>
    </section>
  )
}
