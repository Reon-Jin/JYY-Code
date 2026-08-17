/** @jsxImportSource @opentui/solid */
// Settings — 与 desktop features/settings/* 对齐（跳过 Tauri 专属项：启动位置/系统通知/自动更新安装）。
// 数据全部来自 @jyycode-ai/sdk/v2（api.client.global.config / global.defaultPermission / global.compaction / global.managementContext）。
import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import type { GlobalCompaction } from "@jyycode-ai/sdk/v2"
import { useBindings } from "@tui/keymap"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { createResource, createSignal, For, Show } from "solid-js"

export const ROUTE = "settings"

// ---------- 纯逻辑（可测） ----------

export type CompactionForm = {
  auto: boolean
  triggerRatio: number
  tailTurns: number
  microCompact: boolean
  reactiveCompact: boolean
}

export function compactionToForm(compaction: GlobalCompaction): CompactionForm {
  return {
    auto: compaction.auto,
    triggerRatio: compaction.triggerRatio,
    tailTurns: compaction.tailTurns,
    microCompact: compaction.microCompact,
    reactiveCompact: compaction.reactiveCompact,
  }
}

export function validateCompaction(input: CompactionForm): { triggerRatio?: string; tailTurns?: string } | null {
  const errors: { triggerRatio?: string; tailTurns?: string } = {}
  if (Number.isNaN(input.triggerRatio) || input.triggerRatio <= 0 || input.triggerRatio > 1) {
    errors.triggerRatio = "触发比例必须在 0-1 之间"
  }
  if (!Number.isInteger(input.tailTurns) || input.tailTurns < 1) {
    errors.tailTurns = "保留轮数必须是 ≥1 的整数"
  }
  return Object.keys(errors).length > 0 ? errors : null
}

export function permissionPolicyLabel(mode: string): string {
  switch (mode) {
    case "auto":
      return "auto（自动）"
    case "request":
      return "request（请求确认）"
    case "full":
      return "full（全部允许）"
    case "custom":
      return "custom（自定义）"
    default:
      return mode
  }
}

export function formatConfigPath(directory: string): string {
  const separator = directory.includes("\\") ? "\\" : "/"
  return `${directory.replace(/[\\/]+$/, "")}${separator}jyycode.jsonc`
}

// ---------- 视图 ----------

type Section =
  | { kind: "shell"; title: string; value: string }
  | { kind: "permission"; title: string; value: string }
  | { kind: "compaction"; title: string; value: string }
  | { kind: "config-path"; title: string; value: string }

function SettingsView(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [selected, setSelected] = createSignal(0)
  const [refresh, setRefresh] = createSignal(0)

  const [data] = createResource(refresh, async () => {
    const [configResult, permissionResult, compactionResult, ctxResult] = await Promise.all([
      props.api.client.global.config.get().catch(() => undefined),
      props.api.client.global.defaultPermission.get().catch(() => undefined),
      props.api.client.global.compaction.get().catch(() => undefined),
      props.api.client.global.managementContext().catch(() => undefined),
    ])
    return {
      shell: configResult?.data?.shell ?? "（未设置，使用系统默认）",
      permission: permissionResult?.data?.mode ?? "unknown",
      compaction: compactionResult?.data,
      configPath: formatConfigPath(ctxResult?.data?.directory ?? "~/.config/jyycode"),
    }
  })

  const sections = (): Section[] => {
    const d = data()
    const compaction = d?.compaction
    return [
      { kind: "shell", title: "默认 Shell", value: d?.shell ?? "加载中…" },
      { kind: "permission", title: "默认权限策略", value: permissionPolicyLabel(d?.permission ?? "unknown") },
      {
        kind: "compaction",
        title: "上下文压缩",
        value: compaction ? `auto=${compaction.auto} · 触发=${Math.round(compaction.triggerRatio * 100)}% · 保留=${compaction.tailTurns}轮` : "加载中…",
      },
      { kind: "config-path", title: "全局配置路径", value: d?.configPath ?? "加载中…" },
    ]
  }

  const current = () => sections()[Math.min(selected(), Math.max(sections().length - 1, 0))]

  function toastError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    props.api.ui.toast({ message, variant: "error" })
  }

  async function refreshAll() {
    setRefresh((x) => x + 1)
  }

  function editShell() {
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="默认 Shell"
        description={() => (
          <box>
            <text fg={theme.textMuted}>输入 shell 命令（如 bash / zsh / powershell.exe）。作用于新建 Session。</text>
          </box>
        )}
        value={data()?.shell && data()?.shell !== "（未设置，使用系统默认）" ? data()!.shell : ""}
        placeholder="bash"
        onCancel={() => props.api.ui.dialog.clear()}
        onConfirm={async (value) => {
          props.api.ui.dialog.clear()
          try {
            await props.api.client.global.config.update({ config: { shell: value.trim() || undefined } })
            await refreshAll()
          } catch (error) {
            toastError(error)
          }
        }}
      />
    ))
  }

  function editPermission() {
    const options = [
      { title: "auto（自动）", description: "按模型置信度自动放行常用工具", value: "auto" as const },
      { title: "request（请求确认）", description: "每次工具调用请求确认", value: "request" as const },
      { title: "full（全部允许）", description: "直接放行所有工具", value: "full" as const },
    ]
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title="默认权限策略"
        options={options}
        onSelect={async (option) => {
          props.api.ui.dialog.clear()
          try {
            await props.api.client.global.defaultPermission.update({ mode: option.value })
            await refreshAll()
          } catch (error) {
            toastError(error)
          }
        }}
      />
    ))
  }

  function editCompaction() {
    const current = data()?.compaction
    if (!current) return
    const form = compactionToForm(current)
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="压缩触发比例（0-1）"
        description={() => (
          <box>
            <text fg={theme.textMuted}>当前：{form ? Math.round(form.triggerRatio * 100) : "?"}%（保留轮数 {form?.tailTurns ?? "?"}）</text>
          </box>
        )}
        value={form ? String(form.triggerRatio) : "0.8"}
        placeholder="0.8"
        onCancel={() => props.api.ui.dialog.clear()}
        onConfirm={async (ratio) => {
          props.api.ui.dialog.clear()
          if (!current) return
          const next: CompactionForm = {
            ...compactionToForm(current),
            triggerRatio: Number.parseFloat(ratio),
          }
          const errors = validateCompaction(next)
          if (errors) {
            toastError(new Error(Object.values(errors).join("；")))
            return
          }
          try {
            await props.api.client.global.compaction.update({
              globalCompaction: { ...current, triggerRatio: next.triggerRatio },
            })
            await refreshAll()
          } catch (error) {
            toastError(error)
          }
        }}
      />
    ))
  }

  function resetCompaction() {
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogConfirm
        title="重置压缩设置"
        message="确认将上下文压缩恢复为默认值？"
        onConfirm={() => {
          props.api.ui.dialog.clear()
          void props.api.client.global.compaction
            .reset()
            .then(refreshAll)
            .catch(toastError)
        }}
        onCancel={() => props.api.ui.dialog.clear()}
      />
    ))
  }

  function openSection(section: Section) {
    switch (section.kind) {
      case "shell":
        editShell()
        break
      case "permission":
        editPermission()
        break
      case "compaction":
        editCompaction()
        break
      case "config-path":
        props.api.ui.toast({ message: `配置文件：${section.value}`, variant: "info" })
        break
    }
  }

  useBindings(() => ({
    bindings: [
      {
        key: "escape",
        desc: "返回",
        group: "Settings",
        cmd() {
          props.api.route.navigate("home")
        },
      },
      {
        key: "up",
        desc: "上移",
        group: "Settings",
        cmd() {
          setSelected((x) => Math.max(0, x - 1))
        },
      },
      {
        key: "down",
        desc: "下移",
        group: "Settings",
        cmd() {
          setSelected((x) => Math.min(sections().length - 1, x + 1))
        },
      },
      {
        key: "enter",
        desc: "编辑",
        group: "Settings",
        cmd() {
          const section = current()
          if (section) openSection(section)
        },
      },
      {
        key: "r",
        desc: "重置压缩",
        group: "Settings",
        cmd() {
          if (current()?.kind === "compaction") resetCompaction()
        },
      },
      {
        key: "x",
        desc: "刷新",
        group: "Settings",
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
          <b>设置</b>
        </text>
        <text fg={theme.textMuted}>  — 全局后端配置（跨项目生效；部分选项仅影响新建 Session）</text>
      </box>
      <Show when={data.loading}>
        <box paddingLeft={2} paddingTop={1}>
          <text fg={theme.textMuted}>加载中…</text>
        </box>
      </Show>
      <Show when={!data.loading}>
        <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
          <For each={sections()}>
            {(section, i) => {
              const isSelected = () => selected() === i()
              return (
                <box flexDirection="row" gap={1} paddingTop={1} paddingBottom={1}>
                  <text fg={isSelected() ? theme.primary : theme.textMuted} width={2}>
                    {isSelected() ? "›" : " "}
                  </text>
                  <text fg={isSelected() ? theme.primary : theme.text} width={20}>
                    {section.title}
                  </text>
                  <text fg={theme.textMuted} flexGrow={1}>
                    {section.value}
                  </text>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </Show>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.textMuted}>↑/↓ 选择 · Enter 编辑 · r 重置压缩 · x 刷新 · Esc 返回</text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <SettingsView api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "settings.open",
        title: "设置（全局）",
        slashName: "settings",
        category: "System",
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
  id: "settings",
  tui,
}
