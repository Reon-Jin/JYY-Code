/** @jsxImportSource @opentui/solid */
// Blackboard 面板 — 与 desktop features/blackboard/blackboard-panel.tsx 对齐。
// 数据全部来自 @jyycode-ai/sdk/v2（api.client.session.blackboard2.read/post）。
import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import type { SessionBlackboardResponse } from "@jyycode-ai/sdk/v2"
import { useBindings } from "@tui/keymap"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"

export const ROUTE = "blackboard"

export type BlackboardMessage = NonNullable<SessionBlackboardResponse>["messages"][number]
export type BlackboardSnapshot = NonNullable<SessionBlackboardResponse>

// ---------- 纯逻辑（可测） ----------

export function blackboardItems(messages: readonly BlackboardMessage[]): BlackboardMessage[] {
  return [...messages].sort((a, b) => a.timeCreated - b.timeCreated)
}

export function kindLabel(kind: BlackboardMessage["kind"]): string {
  switch (kind) {
    case "info":
      return "信息"
    case "risk":
      return "风险"
    case "blocker":
      return "阻塞"
    case "decision":
      return "决策"
    case "help":
      return "求助"
  }
}

export function authorLabel(message: BlackboardMessage): string {
  switch (message.authorKind) {
    case "user":
      return "用户"
    case "main_agent":
      return "主 Agent"
    case "sub_agent":
      return `子 Agent${message.authorTaskID ? ` (${message.authorTaskID})` : ""}`
  }
}

// ---------- 视图 ----------

function BlackboardPanelView(props: { api: TuiPluginApi; sessionID: string }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [refresh, setRefresh] = createSignal(0)
  const [data] = createResource([() => props.sessionID, refresh], async () => {
    const result = await props.api.client.session.blackboard({ sessionID: props.sessionID }).catch(() => undefined)
    return result?.data ?? undefined
  })
  const snapshot = () => data()
  const messages = () => blackboardItems(snapshot()?.messages ?? [])

  const off = props.api.event.on("blackboard.updated", (event) => {
    if (event.properties.rootSessionID === props.sessionID) setRefresh((x) => x + 1)
  })
  onCleanup(off)

  function postMessage() {
    const kinds = [
      { title: "info（信息）", value: "info" as const },
      { title: "risk（风险）", value: "risk" as const },
      { title: "blocker（阻塞）", value: "blocker" as const },
      { title: "decision（决策）", value: "decision" as const },
      { title: "help（求助）", value: "help" as const },
    ]
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title="发布 Blackboard 消息类型"
        options={kinds}
        onSelect={(option) => {
          props.api.ui.dialog.clear()
          props.api.ui.dialog.replace(() => (
            <props.api.ui.DialogPrompt
              title={`发布消息（${option.title}）`}
              placeholder="输入消息内容"
              onCancel={() => props.api.ui.dialog.clear()}
              onConfirm={async (message) => {
                props.api.ui.dialog.clear()
                if (!message.trim()) return
                try {
                  await props.api.client.session.blackboard2.post({
                    sessionID: props.sessionID,
                    kind: option.value,
                    message: message.trim(),
                  })
                  setRefresh((x) => x + 1)
                } catch (error) {
                  const text = error instanceof Error ? error.message : String(error)
                  props.api.ui.toast({ message: text, variant: "error" })
                }
              }}
            />
          ))
        }}
      />
    ))
  }

  useBindings(() => ({
    bindings: [
      {
        key: "escape",
        desc: "返回",
        group: "Blackboard",
        cmd() {
          props.api.route.navigate("session", { sessionID: props.sessionID })
        },
      },
      {
        key: "p",
        desc: "发布消息",
        group: "Blackboard",
        cmd() {
          postMessage()
        },
      },
      {
        key: "r",
        desc: "刷新",
        group: "Blackboard",
        cmd() {
          setRefresh((x) => x + 1)
        },
      },
    ],
  }))

  const kindColor = (kind: BlackboardMessage["kind"]) => {
    switch (kind) {
      case "info":
        return theme.textMuted
      case "risk":
        return theme.warning
      case "blocker":
        return theme.error
      case "decision":
        return theme.primary
      case "help":
        return theme.success
    }
  }

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background} flexDirection="column">
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <text fg={theme.text}>
          <b>Blackboard</b>
        </text>
        <text fg={theme.textMuted}>
          {"  "}未读 {snapshot()?.unreadCount ?? 0} · 任务 {snapshot()?.tasks.length ?? 0}
        </text>
      </box>
      <Show when={data.loading}>
        <box paddingLeft={2} paddingTop={1}>
          <text fg={theme.textMuted}>加载中…</text>
        </box>
      </Show>
      <Show when={!data.loading && snapshot() === undefined}>
        <box paddingLeft={2} paddingTop={1}>
          <text fg={theme.textMuted}>无法读取 blackboard（该会话可能不是多智能体 root session）。</text>
        </box>
      </Show>
      <Show when={!data.loading && snapshot() !== undefined}>
        <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
          <For each={messages()}>
            {(message) => (
              <box flexDirection="column" paddingTop={1} paddingBottom={1}>
                <box flexDirection="row" gap={1}>
                  <text fg={kindColor(message.kind)} width={6}>
                    {kindLabel(message.kind)}
                  </text>
                  <text fg={theme.textMuted}>{authorLabel(message)}</text>
                  <text fg={theme.textMuted}>{new Date(message.timeCreated).toLocaleTimeString()}</text>
                </box>
                <box paddingLeft={2}>
                  <text fg={theme.text}>{message.body}</text>
                </box>
              </box>
            )}
          </For>
          <Show when={messages().length === 0}>
            <box paddingTop={2}>
              <text fg={theme.textMuted}>暂无 blackboard 消息。按 p 发布。</text>
            </box>
          </Show>
        </scrollbox>
      </Show>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.textMuted}>p 发布 · r 刷新 · Esc 返回</text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: (input) => (
        <BlackboardPanelView api={api} sessionID={String((input.params as { sessionID?: unknown })?.sessionID ?? "")} />
      ),
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "blackboard.show",
        title: "Blackboard 面板",
        slashName: "blackboard",
        category: "Session",
        namespace: "palette",
        enabled: () => api.route.current.name === "session",
        run() {
          const current = api.route.current
          if (current.name !== "session") return
          const sessionID = String(current.params?.sessionID ?? "")
          if (!sessionID) return
          api.ui.dialog.clear()
          api.route.navigate(ROUTE, { sessionID })
        },
      },
    ],
  })
}

export default {
  id: "blackboard-panel",
  tui,
}
