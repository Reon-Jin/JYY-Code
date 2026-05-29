import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Global } from "@jyycode-ai/core/global"
import type { RGBA } from "@opentui/core"
import path from "path"

type TuiColor = string | RGBA

type ThemeLike = {
  text: TuiColor
  textMuted: TuiColor
  warning: TuiColor
}

type EmailStats = {
  totalProcessed: number
  currentlyProcessing: boolean
  processingCount?: number
  processedCount?: number
  pendingCount: number
  queueLength: number
}

export function EmailStatsText(props: { directory: () => string | undefined; theme: () => ThemeLike }) {
  const [stats, setStats] = createSignal<EmailStats>()
  const statsFile = createMemo(() => {
    return path.join(Global.Path.data, "email-stats.json")
  })
  const counts = createMemo(() => {
    const current = stats()
    if (!current) return
    return {
      pending: current.pendingCount + current.queueLength,
      processing: current.processingCount ?? (current.currentlyProcessing ? 1 : 0),
      processed: current.processedCount ?? current.totalProcessed,
    }
  })

  const refresh = () => {
    const file = statsFile()
    if (!file) {
      setStats(undefined)
      return
    }
    void Bun.file(file)
      .exists()
      .then((exists) => (exists ? Bun.file(file).json() : undefined))
      .then((value) => setStats(readStats(value)))
      .catch(() => setStats(undefined))
  }

  onMount(() => {
    refresh()
    const timer = setInterval(refresh, 1000).unref()
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={counts()}>
      {(item) => (
        <text fg={props.theme().text}>
          <span
            style={{
              fg: item().pending > 0 || item().processing > 0 ? props.theme().warning : props.theme().textMuted,
            }}
          >
            邮件
          </span>{" "}
          待处理 {item().pending} 处理中 {item().processing} 已处理 {item().processed}
        </text>
      )}
    </Show>
  )
}

function readStats(value: unknown): EmailStats | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const item = value as Record<string, unknown>
  if (typeof item.totalProcessed !== "number") return
  if (typeof item.currentlyProcessing !== "boolean") return
  if (typeof item.pendingCount !== "number") return
  if (typeof item.queueLength !== "number") return
  return {
    totalProcessed: item.totalProcessed,
    currentlyProcessing: item.currentlyProcessing,
    processingCount: typeof item.processingCount === "number" ? item.processingCount : undefined,
    processedCount: typeof item.processedCount === "number" ? item.processedCount : undefined,
    pendingCount: item.pendingCount,
    queueLength: item.queueLength,
  }
}
