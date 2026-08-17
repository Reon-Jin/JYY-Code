/** @jsxImportSource @opentui/solid */
// Workspace / Worktree 管理 — 对齐 desktop features/workspace-inspector/* 与 Home 项目管理。
// 数据全部来自 @jyycode-ai/sdk/v2（api.client.experimental.workspace.* / experimental.worktree.*）。
import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import type { Workspace } from "@jyycode-ai/sdk/v2"
import { useBindings } from "@tui/keymap"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { createResource, createSignal, For, Show } from "solid-js"

export const ROUTE = "workspaces"

export type WorkspaceStatus = "connected" | "connecting" | "disconnected" | "error"

// ---------- 纯逻辑（可测） ----------

export function workspaceStatusLabel(status: WorkspaceStatus): string {
  switch (status) {
    case "connected":
      return "已连接"
    case "connecting":
      return "连接中"
    case "disconnected":
      return "未连接"
    case "error":
      return "错误"
  }
}

export function workspaceStatusSymbol(status: WorkspaceStatus): string {
  switch (status) {
    case "connected":
      return "●"
    case "connecting":
      return "◌"
    case "disconnected":
      return "○"
    case "error":
      return "✕"
  }
}

// ---------- 视图 ----------

function WorkspacesView(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [selected, setSelected] = createSignal(0)
  const [refresh, setRefresh] = createSignal(0)

  const [data] = createResource(refresh, async () => {
    const [workspaceResult, statusResult, worktreeResult] = await Promise.all([
      props.api.client.experimental.workspace.list().catch(() => undefined),
      props.api.client.experimental.workspace.status().catch(() => undefined),
      props.api.client.worktree.list().catch(() => undefined),
    ])
    const statuses = new Map((statusResult?.data ?? []).map((item) => [item.workspaceID, item.status]))
    return {
      workspaces: workspaceResult?.data ?? [],
      statuses,
      worktrees: worktreeResult?.data ?? [],
    }
  })

  const workspaces = () => data()?.workspaces ?? []
  const statusOf = (id: string): WorkspaceStatus => data()?.statuses.get(id) ?? "disconnected"
  const current = () => workspaces()[Math.min(selected(), Math.max(workspaces().length - 1, 0))]

  function toastError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    props.api.ui.toast({ message, variant: "error" })
  }

  async function refreshAll() {
    setRefresh((x) => x + 1)
  }

  function statusColor(status: WorkspaceStatus) {
    switch (status) {
      case "connected":
        return theme.success
      case "connecting":
        return theme.warning
      case "error":
        return theme.error
      default:
        return theme.textMuted
    }
  }

  async function switchWorkspace(workspace: Workspace) {
    try {
      await props.api.client.experimental.workspace.warp({ id: workspace.id })
      await refreshAll()
    } catch (error) {
      toastError(error)
    }
  }

  async function removeWorkspace(workspace: Workspace) {
    const ok = await new Promise<boolean>((resolve) => {
      props.api.ui.dialog.replace(() => (
        <props.api.ui.DialogConfirm
          title="移除 Workspace"
          message={`确认移除 workspace "${workspace.name}"？`}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ))
    })
    props.api.ui.dialog.clear()
    if (!ok) return
    try {
      await props.api.client.experimental.workspace.remove({ id: workspace.id })
      await refreshAll()
    } catch (error) {
      toastError(error)
    }
  }

  function actionMenu(workspace: Workspace) {
    const options = [
      { title: "切换", description: "warp 到该 workspace", value: "switch" },
      { title: "移除", description: "移除该 workspace", value: "remove" },
    ]
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title={`操作：${workspace.name}`}
        options={options}
        onSelect={(option) => {
          props.api.ui.dialog.clear()
          if (option.value === "switch") void switchWorkspace(workspace)
          else void removeWorkspace(workspace)
        }}
      />
    ))
  }

  useBindings(() => ({
    bindings: [
      {
        key: "escape",
        desc: "返回",
        group: "Workspaces",
        cmd() {
          props.api.route.navigate("home")
        },
      },
      {
        key: "up",
        desc: "上移",
        group: "Workspaces",
        cmd() {
          setSelected((x) => Math.max(0, x - 1))
        },
      },
      {
        key: "down",
        desc: "下移",
        group: "Workspaces",
        cmd() {
          setSelected((x) => Math.min(workspaces().length - 1, x + 1))
        },
      },
      {
        key: "enter",
        desc: "操作",
        group: "Workspaces",
        cmd() {
          const workspace = current()
          if (workspace) actionMenu(workspace)
        },
      },
      {
        key: "r",
        desc: "刷新",
        group: "Workspaces",
        cmd() {
          void refreshAll()
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background} flexDirection="column">
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <text fg={theme.text}>
          <b>Workspaces</b>
        </text>
        <text fg={theme.textMuted}>  — 项目 workspace / worktree 管理</text>
      </box>
      <Show when={data.loading}>
        <box paddingLeft={2} paddingTop={1}>
          <text fg={theme.textMuted}>加载中…</text>
        </box>
      </Show>
      <Show when={!data.loading}>
        <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
          <For each={workspaces()}>
            {(workspace, i) => {
              const isSelected = () => selected() === i()
              const status = statusOf(workspace.id)
              return (
                <box flexDirection="row" gap={1} paddingTop={1} paddingBottom={1}>
                  <text fg={isSelected() ? theme.primary : theme.textMuted} width={2}>
                    {isSelected() ? "›" : " "}
                  </text>
                  <text fg={statusColor(status)} width={2}>
                    {workspaceStatusSymbol(status)}
                  </text>
                  <text fg={isSelected() ? theme.primary : theme.text} width={24}>
                    {workspace.name}
                  </text>
                  <text fg={theme.textMuted} width={14}>
                    {workspace.type}
                  </text>
                  <text fg={theme.textMuted} flexGrow={1}>
                    {workspace.directory ?? workspace.branch ?? ""}
                  </text>
                  <text fg={statusColor(status)}>{workspaceStatusLabel(status)}</text>
                </box>
              )
            }}
          </For>
          <Show when={workspaces().length === 0}>
            <box paddingTop={2}>
              <text fg={theme.textMuted}>暂无 workspace。</text>
            </box>
          </Show>
        </scrollbox>
      </Show>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.textMuted}>↑/↓ 选择 · Enter 操作 · r 刷新 · Esc 返回</text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <WorkspacesView api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "workspaces.show",
        title: "Workspaces 管理",
        slashName: "workspaces",
        slashAliases: ["workspace", "worktree"],
        category: "Workspace",
        namespace: "palette",
        run() {
          api.route.navigate(ROUTE)
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

export default {
  id: "workspace-manage",
  tui,
}
