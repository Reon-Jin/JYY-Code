import { createMemo, createSignal, Show, createEffect } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import { useTerminalDimensions } from "@opentui/solid"

export function SubagentGuidance() {
  const route = useRouteData("session")
  const sync = useSync()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(route.sessionID))

  // Only show for child sessions
  const isChildSession = createMemo(() => {
    const s = session()
    if (!s) return false
    return !!s.parentID
  })

  // Check cluster task binding
  const clusterTask = createMemo(() => {
    const s = session()
    if (!s?.parentID) return undefined
    // Search agent_cluster state for a task matching this child session
    const cluster = sync.data.agent_cluster[s.parentID]
    if (!cluster) return undefined
    const task = cluster.tasks.find((t) => t.child_session_id === route.sessionID)
    if (!task) return undefined
    return {
      planTaskID: task.plan_task_id ?? task.id,
      status: task.status,
      runID: task.run_id,
    }
  })

  const isTerminal = createMemo(() => {
    const task = clusterTask()
    if (!task) return true
    return ["accepted", "failed", "cancelled"].includes(task.status)
  })

  const [mode, setMode] = createSignal<"next_checkpoint" | "parent_only">("next_checkpoint")
  const [content, setContent] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [feedback, setFeedback] = createSignal<string | undefined>()
  const [feedbackError, setFeedbackError] = createSignal(false)

  const enforceLength = (value: string) => {
    if (value.length <= 5000) return value
    return value.slice(0, 5000)
  }

  const sendGuidance = async () => {
    const text = enforceLength(content().trim())
    if (!text) return
    const task = clusterTask()
    if (!task) return

    setSending(true)
    setFeedback(undefined)
    try {
      const sessionID = route.sessionID
      // Use the parent session's workspace routing
      const url = `/session/${sessionID}/agent-cluster/task/${task.planTaskID}/intervention`
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: mode(), content: text }),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "Request failed")
        setFeedback(errText)
        setFeedbackError(true)
      } else {
        const result = await resp.json() as { id: string; sequence: number }
        setFeedback(`Guidance queued (#${result.sequence}). The subagent will see it at its next checkpoint.`)
        setFeedbackError(false)
        setContent("")
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Failed to send guidance")
      setFeedbackError(true)
    } finally {
      setSending(false)
    }
  }

  // Clear feedback after a timeout
  createEffect(() => {
    const msg = feedback()
    if (msg) {
      const to = setTimeout(() => setFeedback(undefined), 8000)
      return () => clearTimeout(to)
    }
  })

  useTerminalDimensions()

  return (
    <Show when={isChildSession()}>
      <box flexShrink={0}>
        <box
          paddingTop={0}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={1}
          {...SplitBorder}
          border={["left"]}
          borderColor={theme.border}
          flexShrink={0}
          backgroundColor={theme.backgroundPanel}
        >
          <box flexDirection="column" gap={1} width="100%">
            {/* Header row */}
            <box flexDirection="row" justifyContent="space-between" gap={1}>
              <text fg={theme.textMuted}>
                <b>Guide subagent</b>
                <Show when={isTerminal()}>
                  <span style={{ fg: theme.textMuted }}> (task is terminal)</span>
                </Show>
              </text>
              {/* Mode selector */}
              <box flexDirection="row" gap={1}>
                <text
                  onMouseUp={() => setMode("next_checkpoint")}
                  style={{
                    fg: mode() === "next_checkpoint" ? theme.text : theme.textMuted,
                    bold: mode() === "next_checkpoint",
                  }}
                >
                  at checkpoint
                </text>
                <text fg={theme.textMuted}>|</text>
                <text
                  onMouseUp={() => setMode("parent_only")}
                  style={{
                    fg: mode() === "parent_only" ? theme.text : theme.textMuted,
                    bold: mode() === "parent_only",
                  }}
                >
                  parent only
                </text>
              </box>
            </box>

            {/* Input row */}
            <box flexDirection="row" gap={1} width="100%">
              <box flexGrow={1}>
                <Show when={!isTerminal()} fallback={<text fg={theme.textMuted}>Cannot guide a finished task.</text>}>
                  <text
                    editable={true}
                    value={content()}
                    onChange={(v: string) => setContent(enforceLength(v))}
                    placeholder="Guide this subagent..."
                    multiline={true}
                  />
                </Show>
              </box>
              <box flexShrink={0} justifyContent="center" paddingLeft={1}>
                <text
                  onMouseUp={() => sendGuidance()}
                  style={{
                    fg: sending() || isTerminal() ? theme.textMuted : theme.textAccent ?? theme.text,
                    bold: !sending() && !isTerminal(),
                  }}
                >
                  {sending() ? "..." : "Send"}
                </text>
              </box>
            </box>

            {/* Feedback row */}
            <Show when={feedback()}>
              {(msg) => (
                <text fg={feedbackError() ? theme.textError ?? theme.text : theme.textMuted} wrapMode="wrap">
                  {msg()}
                </text>
              )}
            </Show>
          </box>
        </box>
      </box>
    </Show>
  )
}
