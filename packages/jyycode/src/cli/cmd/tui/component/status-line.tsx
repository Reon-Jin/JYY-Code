import { createMemo, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"
import type { AssistantMessage } from "@jyycode-ai/sdk/v2"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

function Separator() {
  const { theme } = useTheme()
  return <text fg={theme.border}> │ </text>
}

type StatusLineProps = {
  sessionID: string
  modelName: string
  contextWindowSize?: number
}

export function StatusLine(props: StatusLineProps) {
  const { theme } = useTheme()
  const sync = useSync()

  const msg = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const session = createMemo(() => sync.session.get(props.sessionID))
  const cost = createMemo(() => session()?.cost ?? 0)

  const usage = createMemo(() => {
    const last = msg()
      .findLast(
        (item): item is AssistantMessage =>
          item.role === "assistant" && item.tokens.output > 0,
      )
    if (!last) return null

    const tokens =
      last.tokens.input +
      last.tokens.output +
      last.tokens.reasoning +
      last.tokens.cache.read +
      last.tokens.cache.write
    const ctxSize = props.contextWindowSize
    const percent = ctxSize ? Math.round((tokens / ctxSize) * 100) : null
    return { tokens, percent, contextWindow: ctxSize }
  })

  return (
    <box flexDirection="row" flexShrink={0} paddingTop={1}>
      <text fg={theme.text}>{props.modelName}</text>
      <Show when={usage()}>
        {(u) => (
          <>
            <Separator />
            <text fg={theme.textMuted}>Context </text>
            <text fg={theme.text}>
              {u().percent ?? "-"}%
            </text>
            <Show when={u().contextWindow}>
              <text fg={theme.textMuted}>
                {" "}({formatTokens(u().tokens)}/{formatTokens(u().contextWindow!)})
              </text>
            </Show>
          </>
        )}
      </Show>
      <Show when={cost() > 0}>
        <Separator />
        <text fg={theme.text}>{money.format(cost())}</text>
      </Show>
    </box>
  )
}
