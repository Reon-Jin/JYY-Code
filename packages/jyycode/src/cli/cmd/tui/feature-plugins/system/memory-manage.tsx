/** @jsxImportSource @opentui/solid */
// Memory 管理 — 与 desktop features/settings/memory-settings-route.tsx 对齐（User/Task/Experience 三页）。
// 数据全部来自 @jyycode-ai/sdk/v2（api.client.memory.list/update/remove/compact/export、user.create、task.clear）。
import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import type { GlobalMemoryEntry } from "@jyycode-ai/sdk/v2"
import { useBindings } from "@tui/keymap"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import * as Editor from "@tui/util/editor"
import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"

export const ROUTE = "memory"

export type MemoryScope = "user" | "task" | "experience"

// ---------- 纯逻辑（可测） ----------

export function memoryScopeLabel(scope: MemoryScope): string {
  switch (scope) {
    case "user":
      return "User"
    case "task":
      return "Task"
    case "experience":
      return "Experience"
  }
}

export function memorySearchFilter<T extends { content: string; keywords?: Array<string> }>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter((item) => {
    const haystack = [item.content, ...(item.keywords ?? [])].join("\n").toLowerCase()
    return haystack.includes(q)
  })
}

export function memoryImportanceLabel(importance: number): string {
  if (importance >= 8) return "高"
  if (importance >= 4) return "中"
  return "低"
}

export function memoryEntrySummary(entry: GlobalMemoryEntry): string {
  const firstLine = entry.content.split("\n")[0] ?? ""
  const preview = firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine
  return preview || "(空)"
}

export function memoryDateLabel(entry: GlobalMemoryEntry): string {
  switch (entry.scope) {
    case "experience":
      return entry.kind
    case "task":
      return entry.date.slice(0, 10)
    case "user":
      return entry.date?.slice(0, 10) ?? ""
  }
}

// ---------- 视图 ----------

function MemoryManageView(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [scope, setScope] = createSignal<MemoryScope>("user")
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [refresh, setRefresh] = createSignal(0)

  const [data] = createResource([scope, refresh], async ([currentScope]) => {
    const result = await props.api.client.memory
      .list({ scope: currentScope, limit: "200" })
      .catch(() => undefined)
    return result?.data?.entries ?? []
  })

  const allEntries = createMemo(() => data() ?? [])
  const entries = createMemo(() => memorySearchFilter(allEntries(), query()))
  const current = createMemo(() => entries()[Math.min(selected(), Math.max(entries().length - 1, 0))])

  function toastError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    props.api.ui.toast({ message, variant: "error" })
  }

  async function refreshAll() {
    setSelected(0)
    setRefresh((x) => x + 1)
  }

  async function removeEntry(entry: GlobalMemoryEntry) {
    const ok = await new Promise<boolean>((resolve) => {
      props.api.ui.dialog.replace(() => (
        <props.api.ui.DialogConfirm
          title="删除记忆"
          message={`确认删除该 ${memoryScopeLabel(entry.scope)} 记忆？`}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ))
    })
    props.api.ui.dialog.clear()
    if (!ok) return
    try {
      await props.api.client.memory.remove({ scope: entry.scope, id: entry.id })
      await refreshAll()
    } catch (error) {
      toastError(error)
    }
  }

  async function editContent(entry: GlobalMemoryEntry) {
    const value = await Editor.open({ value: entry.content, renderer: props.api.renderer })
    if (value === undefined || value === entry.content) return
    const body =
      entry.scope === "experience"
        ? { kind: entry.kind, importance: entry.importance, keywords: entry.keywords, content: value }
        : { importance: entry.importance, keywords: entry.keywords, content: value }
    try {
      await props.api.client.memory.update({ scope: entry.scope, id: entry.id, body })
      await refreshAll()
    } catch (error) {
      toastError(error)
    }
  }

  async function setImportance(entry: GlobalMemoryEntry) {
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="设置重要度（1-10）"
        value={String(entry.importance)}
        placeholder="5"
        onCancel={() => props.api.ui.dialog.clear()}
        onConfirm={async (value) => {
          props.api.ui.dialog.clear()
          const importance = Number.parseInt(value, 10)
          if (Number.isNaN(importance) || importance < 1 || importance > 10) {
            toastError(new Error("重要度必须是 1-10 的整数"))
            return
          }
          const body =
            entry.scope === "experience"
              ? { kind: entry.kind, importance, keywords: entry.keywords, content: entry.content }
              : { importance, keywords: entry.keywords, content: entry.content }
          try {
            await props.api.client.memory.update({ scope: entry.scope, id: entry.id, body })
            await refreshAll()
          } catch (error) {
            toastError(error)
          }
        }}
      />
    ))
  }

  async function compactScope() {
    const ok = await new Promise<boolean>((resolve) => {
      props.api.ui.dialog.replace(() => (
        <props.api.ui.DialogConfirm
          title="压缩记忆"
          message={`确认压缩 ${memoryScopeLabel(scope())} 记忆？将按确定性规则合并与裁剪。`}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ))
    })
    props.api.ui.dialog.clear()
    if (!ok) return
    try {
      await props.api.client.memory.compact({ scope: scope() })
      props.api.ui.toast({ message: "压缩完成", variant: "info" })
      await refreshAll()
    } catch (error) {
      toastError(error)
    }
  }

  async function exportScope() {
    try {
      const result = await props.api.client.memory.export({ scope: scope() })
      const exported = result.data
      const count = exported && "entries" in exported ? exported.entries.length : 0
      props.api.ui.toast({
        message: `已导出 ${memoryScopeLabel(scope())} 记忆 ${count} 条（详情见后端数据目录）`,
        variant: "info",
      })
    } catch (error) {
      toastError(error)
    }
  }

  async function createUserMemory() {
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="新建 User 记忆"
        description={() => (
          <box>
            <text fg={theme.textMuted}>输入记忆内容（一行摘要，随后可在详情中编辑）。</text>
          </box>
        )}
        onCancel={() => props.api.ui.dialog.clear()}
        onConfirm={async (content) => {
          props.api.ui.dialog.clear()
          if (!content.trim()) return
          try {
            await props.api.client.user.create({
              body: { importance: 5, keywords: [], content: content.trim() },
            })
            await refreshAll()
          } catch (error) {
            toastError(error)
          }
        }}
      />
    ))
  }

  function actionMenu(entry: GlobalMemoryEntry) {
    const options = [
      { title: "编辑内容", description: "用外部编辑器修改", value: "edit" },
      { title: "设置重要度", description: "1-10", value: "importance" },
      { title: "删除", description: "删除该记忆", value: "delete" },
    ]
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogSelect
        title={`操作：${memoryScopeLabel(entry.scope)} 记忆`}
        options={options}
        onSelect={(option) => {
          props.api.ui.dialog.clear()
          switch (option.value) {
            case "edit":
              void editContent(entry)
              break
            case "importance":
              void setImportance(entry)
              break
            case "delete":
              void removeEntry(entry)
              break
          }
        }}
      />
    ))
  }

  useBindings(() => ({
    bindings: [
      {
        key: "escape",
        desc: "返回",
        group: "Memory",
        cmd() {
          props.api.route.navigate("home")
        },
      },
      {
        key: "tab",
        desc: "切换 scope",
        group: "Memory",
        cmd() {
          const next: MemoryScope[] = ["user", "task", "experience"]
          const idx = next.indexOf(scope())
          setScope(next[(idx + 1) % next.length]!)
          void refreshAll()
        },
      },
      {
        key: "/",
        desc: "搜索",
        group: "Memory",
        cmd() {
          props.api.ui.dialog.replace(() => (
            <props.api.ui.DialogPrompt
              title="搜索记忆"
              value={query()}
              placeholder="关键词"
              onCancel={() => props.api.ui.dialog.clear()}
              onConfirm={(value) => {
                setQuery(value)
                setSelected(0)
                props.api.ui.dialog.clear()
              }}
            />
          ))
        },
      },
      {
        key: "up",
        desc: "上移",
        group: "Memory",
        cmd() {
          setSelected((x) => Math.max(0, x - 1))
        },
      },
      {
        key: "down",
        desc: "下移",
        group: "Memory",
        cmd() {
          setSelected((x) => Math.min(entries().length - 1, x + 1))
        },
      },
      {
        key: "enter",
        desc: "操作菜单",
        group: "Memory",
        cmd() {
          const entry = current()
          if (entry) actionMenu(entry)
        },
      },
      {
        key: "c",
        desc: "压缩",
        group: "Memory",
        cmd() {
          void compactScope()
        },
      },
      {
        key: "x",
        desc: "导出",
        group: "Memory",
        cmd() {
          void exportScope()
        },
      },
      {
        key: "a",
        desc: "新建（User）",
        group: "Memory",
        enabled: () => scope() === "user",
        cmd() {
          void createUserMemory()
        },
      },
      {
        key: "r",
        desc: "刷新",
        group: "Memory",
        cmd() {
          void refreshAll()
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background} flexDirection="column">
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexShrink={0} flexDirection="row" gap={1}>
        <text fg={theme.text}>
          <b>Memory 管理</b>
        </text>
        <For each={["user", "task", "experience"] as const}>
          {(item) => (
            <box
              borderStyle={scope() === item ? "round" : undefined}
              borderColor={scope() === item ? theme.primary : theme.border}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={scope() === item ? theme.primary : theme.textMuted}>{memoryScopeLabel(item)}</text>
            </box>
          )}
        </For>
      </box>
      <Show when={query()}>
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexShrink={0}>
          <text fg={theme.warning}>搜索：{query()}（共 {entries().length} 条）</text>
        </box>
      </Show>
      <Show when={data.loading}>
        <box paddingLeft={2} paddingTop={1}>
          <text fg={theme.textMuted}>加载中…</text>
        </box>
      </Show>
      <Show when={!data.loading}>
        <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
          <For each={entries()}>
            {(entry, i) => {
              const isSelected = () => selected() === i()
              const importanceColor = () => {
                if (entry.importance >= 8) return theme.warning
                if (entry.importance >= 4) return theme.primary
                return theme.textMuted
              }
              return (
                <box flexDirection="row" gap={1} paddingTop={1} paddingBottom={1}>
                  <text fg={isSelected() ? theme.primary : theme.textMuted} width={2}>
                    {isSelected() ? "›" : " "}
                  </text>
                  <text fg={importanceColor()} width={4}>
                    {memoryImportanceLabel(entry.importance)}
                  </text>
                  <text fg={theme.textMuted} width={12}>
                    {memoryDateLabel(entry)}
                  </text>
                  <text fg={isSelected() ? theme.primary : theme.text} flexGrow={1}>
                    {memoryEntrySummary(entry)}
                  </text>
                </box>
              )
            }}
          </For>
          <Switch>
            <Match when={!data.loading && entries().length === 0}>
              <box paddingTop={2}>
                <text fg={theme.textMuted}>暂无记忆。按 a 新建（User），或切换 scope。</text>
              </box>
            </Match>
          </Switch>
        </scrollbox>
      </Show>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.textMuted}>
          Tab 切换 scope · ↑/↓ 选择 · Enter 操作 · / 搜索 · c 压缩 · x 导出 · a 新建(User) · r 刷新 · Esc 返回
        </text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <MemoryManageView api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "memory.manage",
        title: "Memory 管理（User/Task/Experience）",
        slashName: "memory",
        category: "Agent",
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
  id: "memory-manage",
  tui,
}
