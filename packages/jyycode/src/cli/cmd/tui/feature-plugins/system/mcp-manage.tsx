/** @jsxImportSource @opentui/solid */
// Global MCP management — 与 desktop features/mcp/mcp-management-page.tsx 对齐。
// 数据全部来自 @jyycode-ai/sdk/v2（api.client.mcp.* / api.client.mcp.config.* / api.client.mcp.auth.*）。
import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import type { McpLocalConfig, McpRemoteConfig, McpStatus } from "@jyycode-ai/sdk/v2"
import { useBindings } from "@tui/keymap"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"

export const ROUTE = "mcp"

// ---------- 纯逻辑（可测） ----------

export type McpEntry = {
  name: string
  config: McpLocalConfig | McpRemoteConfig
  status?: McpStatus
}

export type McpForm = {
  name: string
  command: string
  args: string[]
  environment: Record<string, string>
  enabled: boolean
}

export function buildMcpForm(config: McpLocalConfig | McpRemoteConfig, name: string): McpForm {
  if (config.type === "local") {
    return {
      name,
      command: config.command[0] ?? "",
      args: config.command.slice(1),
      environment: config.environment ?? {},
      enabled: config.enabled ?? true,
    }
  }
  // remote 配置在 TUI 中以只读摘要展示，表单保持空（新建时默认 local）
  return {
    name,
    command: config.url ?? "",
    args: [],
    environment: {},
    enabled: config.enabled ?? true,
  }
}

export function validateMcpForm(form: McpForm): { name?: string; command?: string } {
  const errors: { name?: string; command?: string } = {}
  if (!form.name.trim()) errors.name = "名称不能为空"
  if (!form.command.trim()) errors.command = "命令不能为空"
  return errors
}

export function redactMcpSecret(value: string): { value: string; redacted: boolean } {
  if (!value) return { value: "", redacted: false }
  return { value: "••••••••", redacted: true }
}

export function mcpStatusLabel(status: McpStatus | undefined): string {
  if (!status) return "unknown"
  switch (status.status) {
    case "connected":
      return "connected"
    case "disabled":
      return "disabled"
    case "failed":
      return "failed"
    case "needs_auth":
      return "needs_auth"
    case "needs_client_registration":
      return "needs_client_registration"
  }
}

export function mcpStatusSymbol(status: McpStatus | undefined): string {
  switch (mcpStatusLabel(status)) {
    case "connected":
      return "●"
    case "disabled":
      return "○"
    case "failed":
      return "✕"
    case "needs_auth":
      return "▲"
    default:
      return "?"
  }
}

export function configSummary(config: McpLocalConfig | McpRemoteConfig): string {
  if (config.type === "local") return config.command.join(" ")
  return config.url
}

// ---------- 视图 ----------

function McpManageView(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [selected, setSelected] = createSignal(0)
  const [refresh, setRefresh] = createSignal(0)

  const [data] = createResource(refresh, async () => {
    const [configResult, statusResult] = await Promise.all([
      props.api.client.mcp.config.list().catch(() => undefined),
      props.api.client.mcp.status().catch(() => undefined),
    ])
    const config = configResult?.data ?? {}
    const status = statusResult?.data ?? {}
    const entries: McpEntry[] = Object.entries(config).map(([name, cfg]) => ({
      name,
      config: cfg as McpLocalConfig | McpRemoteConfig,
      status: (status as Record<string, McpStatus>)[name],
    }))
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  })

  const entries = createMemo(() => data() ?? [])
  const current = createMemo(() => entries()[Math.min(selected(), Math.max(entries().length - 1, 0))])
  const statusColor = (status: McpStatus | undefined) => {
    switch (mcpStatusLabel(status)) {
      case "connected":
        return theme.success
      case "disabled":
        return theme.textMuted
      case "failed":
        return theme.error
      case "needs_auth":
        return theme.warning
      default:
        return theme.textMuted
    }
  }

  async function refreshAll() {
    setRefresh((x) => x + 1)
  }

  function toastError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    props.api.ui.toast({ message, variant: "error" })
  }

  async function toggleConnect(entry: McpEntry) {
    if (mcpStatusLabel(entry.status) === "connected") {
      await props.api.client.mcp.disconnect({ name: entry.name })
    } else {
      await props.api.client.mcp.connect({ name: entry.name })
    }
    await refreshAll()
  }

  async function removeEntry(entry: McpEntry) {
    const ok = await new Promise<boolean>((resolve) => {
      props.api.ui.dialog.replace(() => (
        <props.api.ui.DialogConfirm
          title="删除 MCP"
          message={`确认删除全局 MCP 配置 "${entry.name}"？将同时断开连接并移除 OAuth 凭据。`}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ))
    })
    props.api.ui.dialog.clear()
    if (!ok) return
    try {
      await props.api.client.mcp.config.delete({ name: entry.name })
      await refreshAll()
    } catch (error) {
      toastError(error)
    }
  }

  function editEntry(entry: McpEntry) {
    const form = buildMcpForm(entry.config, entry.name)
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title={`编辑 MCP：${entry.name}`}
        description={() => (
          <box>
            <text fg={theme.textMuted}>
              当前命令：{configSummary(entry.config)}（TUI 编辑保留名称，命令行整体重填）
            </text>
          </box>
        )}
        placeholder="npx -y @modelcontextprotocol/server-filesystem"
        value={form.command}
        onCancel={() => props.api.ui.dialog.clear()}
        onConfirm={async (command) => {
          props.api.ui.dialog.clear()
          if (!command.trim()) return
          try {
            await props.api.client.mcp.config.update({
              name: entry.name,
              body: {
                type: "local",
                command: command.trim().split(/\s+/),
                enabled: form.enabled,
                ...(Object.keys(form.environment).length > 0 ? { environment: form.environment } : {}),
              },
            })
            await refreshAll()
          } catch (error) {
            toastError(error)
          }
        }}
      />
    ))
  }

  function addEntry() {
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="新增 MCP"
        description={() => (
          <box>
            <text fg={theme.textMuted}>输入名称（如 fs / git / memory），随后输入启动命令。</text>
          </box>
        )}
        placeholder="server-name"
        onCancel={() => props.api.ui.dialog.clear()}
        onConfirm={(name) => {
          props.api.ui.dialog.clear()
          if (!name.trim()) return
          props.api.ui.dialog.replace(() => (
            <props.api.ui.DialogPrompt
              title={`新增 MCP：${name.trim()}`}
              description={() => (
                <box>
                  <text fg={theme.textMuted}>启动命令（含参数，用空格分隔）。</text>
                </box>
              )}
              placeholder="npx -y @modelcontextprotocol/server-filesystem"
              onCancel={() => props.api.ui.dialog.clear()}
              onConfirm={async (command) => {
                props.api.ui.dialog.clear()
                if (!command.trim()) return
                try {
                  await props.api.client.mcp.config.update({
                    name: name.trim(),
                    body: { type: "local", command: command.trim().split(/\s+/), enabled: true },
                  })
                  await refreshAll()
                } catch (error) {
                  toastError(error)
                }
              }}
            />
          ))
        }}
      />
    ))
  }

  async function runAuth(entry: McpEntry) {
    try {
      await props.api.client.mcp.auth.authenticate({ name: entry.name })
      await refreshAll()
    } catch (error) {
      toastError(error)
    }
  }

  async function removeAuth(entry: McpEntry) {
    const ok = await new Promise<boolean>((resolve) => {
      props.api.ui.dialog.replace(() => (
        <props.api.ui.DialogConfirm
          title="移除 MCP 认证"
          message={`确认移除 "${entry.name}" 的已存储 OAuth 凭据？`}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ))
    })
    props.api.ui.dialog.clear()
    if (!ok) return
    try {
      await props.api.client.mcp.auth.remove({ name: entry.name })
      await refreshAll()
    } catch (error) {
      toastError(error)
    }
  }

  function actionMenu(entry: McpEntry) {
    const options = [
      {
        title: mcpStatusLabel(entry.status) === "connected" ? "断开连接" : "连接",
        description: "连接/断开该 MCP 服务器",
        value: "connect",
      },
      { title: "编辑配置", description: "修改启动命令（名称保持不变）", value: "edit" },
      { title: "OAuth 认证", description: "发起 OAuth 认证流程", value: "auth" },
      { title: "移除 OAuth 凭据", description: "删除已存储的认证", value: "remove-auth" },
      { title: "删除配置", description: "删除全局配置（含凭据）", value: "delete" },
    ]
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title={`操作：${entry.name}`}
        options={options}
        onSelect={async (option) => {
          props.api.ui.dialog.clear()
          switch (option.value) {
            case "connect":
              await toggleConnect(entry).catch(toastError)
              break
            case "edit":
              editEntry(entry)
              break
            case "auth":
              await runAuth(entry)
              break
            case "remove-auth":
              await removeAuth(entry)
              break
            case "delete":
              await removeEntry(entry)
              break
          }
        }}
      />
    ))
  }

  useBindings(() => ({
    enabled: () => true,
    bindings: [
      {
        key: "up",
        desc: "上移",
        group: "MCP",
        cmd() {
          setSelected((x) => Math.max(0, x - 1))
        },
      },
      {
        key: "down",
        desc: "下移",
        group: "MCP",
        cmd() {
          setSelected((x) => Math.min(entries().length - 1, x + 1))
        },
      },
      {
        key: "enter",
        desc: "操作菜单",
        group: "MCP",
        cmd() {
          const entry = current()
          if (entry) actionMenu(entry)
        },
      },
      {
        key: "c",
        desc: "连接/断开",
        group: "MCP",
        cmd() {
          const entry = current()
          if (entry) void toggleConnect(entry).catch(toastError)
        },
      },
      {
        key: "a",
        desc: "新增",
        group: "MCP",
        cmd() {
          addEntry()
        },
      },
      {
        key: "r",
        desc: "刷新",
        group: "MCP",
        cmd() {
          void refreshAll()
        },
      },
      {
        key: "escape",
        desc: "返回",
        group: "MCP",
        cmd() {
          props.api.route.navigate("home")
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background} flexDirection="column">
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <text fg={theme.text}>
          <b>MCP 管理</b>
        </text>
        <text fg={theme.textMuted}>  — 全局配置（跨项目生效，保存于全局 jyycode.jsonc）</text>
      </box>
      <Show when={data.loading} fallback={<></>}>
        <box paddingLeft={2} paddingTop={1}>
          <text fg={theme.textMuted}>加载中…</text>
        </box>
      </Show>
      <Show when={!data.loading}>
        <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
          <For each={entries()}>
            {(entry, i) => {
              const isSelected = () => selected() === i()
              return (
                <box flexDirection="row" gap={1} paddingTop={1} paddingBottom={1}>
                  <text fg={isSelected() ? theme.primary : theme.textMuted}>
                    {isSelected() ? "›" : " "} {mcpStatusSymbol(entry.status)}
                  </text>
                  <text fg={isSelected() ? theme.primary : theme.text} width={24}>
                    {entry.name}
                  </text>
                  <text fg={theme.textMuted} flexGrow={1}>
                    {configSummary(entry.config)}
                  </text>
                  <text fg={statusColor(entry.status)}>{mcpStatusLabel(entry.status)}</text>
                </box>
              )
            }}
          </For>
          <Switch>
            <Match when={!data.loading && entries().length === 0}>
              <box paddingTop={2}>
                <text fg={theme.textMuted}>尚无全局 MCP 配置。按 a 新增。</text>
              </box>
            </Match>
          </Switch>
        </scrollbox>
      </Show>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.textMuted}>
          ↑/↓ 选择 · Enter 操作 · c 连接/断开 · a 新增 · r 刷新 · Esc 返回
        </text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <McpManageView api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "mcp.manage",
        title: "MCP 管理（全局配置）",
        slashName: "mcp",
        category: "Provider",
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
  id: "mcp-manage",
  tui,
}
