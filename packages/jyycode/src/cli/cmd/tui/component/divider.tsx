import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import type { RGBA } from "@opentui/core"

type DividerProps = {
  color?: RGBA
  char?: string
  title?: string
  width?: number
}

export function Divider(props: DividerProps) {
  const { theme } = useTheme()
  const lineChar = () => props.char ?? "─"
  const lineColor = () => props.color ?? theme.border
  const totalWidth = () => props.width ?? 120

  return (
    <box flexDirection="row" flexShrink={0} paddingTop={1} paddingBottom={1}>
      <Show
        when={props.title}
        fallback={<text fg={lineColor()}>{lineChar().repeat(totalWidth())}</text>}
      >
        {(title) => {
          const half = () => Math.max(0, Math.floor((totalWidth() - title().length - 2) / 2))
          return (
            <text fg={lineColor()}>
              {lineChar().repeat(half())}{" "}
              <span style={{ fg: lineColor() }}>{title()}</span>{" "}
              {lineChar().repeat(half())}
            </text>
          )
        }}
      </Show>
    </box>
  )
}
