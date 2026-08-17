/** @jsxImportSource @opentui/solid */
// 文件树 / 预览 — 与 desktop features/files/* 对齐（终端语境：树内预览 + 外部编辑器由会话上下文负责）。
// 数据全部来自 @jyycode-ai/sdk/v2（api.client.file.list/read、api.client.find.files）。
import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import type { FileNode } from "@jyycode-ai/sdk/v2"
import { useBindings } from "@tui/keymap"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"

export const ROUTE = "files"

const HIDDEN = new Set([".git", "node_modules", ".turbo", ".build", "dist", ".artifacts", ".pnpm-store", ".worktrees"])

// ---------- 纯逻辑（可测） ----------

export type FileTreeNode = {
  name: string
  path: string
  children?: FileTreeNode[]
}

export function filterHidden(names: readonly string[]): string[] {
  return names.filter((name) => !HIDDEN.has(name))
}

export function buildFileTree(paths: readonly string[]): FileTreeNode[] {
  const root: FileTreeNode[] = []
  for (const item of paths) {
    const parts = item.split("/").filter(Boolean)
    let level = root
    let prefix = ""
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part
      let node = level.find((n) => n.name === part)
      if (!node) {
        node = { name: part, path: prefix }
        level.push(node)
      }
      if (node.children === undefined && part !== parts[parts.length - 1]) node.children = []
      level = node.children ?? []
    }
  }
  return root
}

export function isTextFile(path: string): boolean {
  return !/(\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tar|exe|dll|so|dylib|bin|wasm|class|pyc|woff2?|ttf|otf|mp3|mp4|mov|avi|sqlite|db))$/i.test(path)
}

export function previewLines(content: string, limit = 200): string[] {
  const lines = content.split("\n")
  return lines.slice(0, limit)
}

// ---------- 视图 ----------

function FilesView(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [dir, setDir] = createSignal("")
  const [history, setHistory] = createSignal<string[]>([])
  const [selected, setSelected] = createSignal(0)
  const [previewPath, setPreviewPath] = createSignal<string | undefined>()

  const [nodes] = createResource(dir, async (path) => {
    const result = await props.api.client.file.list({ path }).catch(() => undefined)
    const list = (result?.data ?? []).filter((node) => !node.ignored)
    return [...list].sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  })
  const entries = () => nodes() ?? []
  const current = () => entries()[Math.min(selected(), Math.max(entries().length - 1, 0))]

  const [preview] = createResource(previewPath, async (path) => {
    if (!path) return undefined
    const result = await props.api.client.file.read({ path }).catch(() => undefined)
    return result?.data
  })

  function toastError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    props.api.ui.toast({ message, variant: "error" })
  }

  function enter() {
    const node = current()
    if (!node) return
    if (node.type === "directory") {
      setHistory((h) => [...h, dir()])
      setDir(node.path)
      setSelected(0)
      setPreviewPath(undefined)
    } else {
      setPreviewPath(node.path)
    }
  }

  function goUp() {
    const h = history()
    const parent = h[h.length - 1]
    setHistory(h.slice(0, -1))
    setDir(parent ?? "")
    setSelected(0)
    setPreviewPath(undefined)
  }

  async function search() {
    props.api.ui.dialog.replace(() => (
      <props.api.ui.DialogPrompt
        title="搜索文件"
        description={() => (
          <box>
            <text fg={theme.textMuted}>glob 模式（如 **/*.ts）。结果展示路径列表。</text>
          </box>
        )}
        placeholder="**/*.ts"
        onCancel={() => props.api.ui.dialog.clear()}
        onConfirm={async (pattern) => {
          props.api.ui.dialog.clear()
          if (!pattern.trim()) return
          try {
            const result = await props.api.client.find.files({ query: pattern.trim(), limit: 50 }).catch(() => undefined)
            const hits = (result?.data ?? []).slice(0, 50)
            if (hits.length === 0) {
              props.api.ui.toast({ message: "无匹配文件", variant: "info" })
              return
            }
            props.api.ui.toast({ message: `找到 ${hits.length} 个匹配`, variant: "info" })
            setPreviewPath(undefined)
            // 展示命中列表：简单起见跳到第一个命中的目录
            const first = hits[0]
            if (typeof first === "string") {
              const slash = first.lastIndexOf("/")
              setDir(slash >= 0 ? first.slice(0, slash) : "")
            }
          } catch (error) {
            toastError(error)
          }
        }}
      />
    ))
  }

  async function copyPath() {
    const node = current()
    if (!node) return
    const { default: clipboard } = await import("clipboardy")
    await clipboard.write(node.path).catch(() => undefined)
    props.api.ui.toast({ message: `已复制：${node.path}`, variant: "info" })
  }

  useBindings(() => ({
    bindings: [
      {
        key: "escape",
        desc: "返回",
        group: "Files",
        cmd() {
          if (previewPath()) setPreviewPath(undefined)
          else if (dir()) goUp()
          else props.api.route.navigate("home")
        },
      },
      {
        key: "up",
        desc: "上移",
        group: "Files",
        cmd() {
          setSelected((x) => Math.max(0, x - 1))
        },
      },
      {
        key: "down",
        desc: "下移",
        group: "Files",
        cmd() {
          setSelected((x) => Math.min(entries().length - 1, x + 1))
        },
      },
      {
        key: "enter",
        desc: "进入/预览",
        group: "Files",
        cmd() {
          enter()
        },
      },
      {
        key: "left",
        desc: "上级目录",
        group: "Files",
        cmd() {
          goUp()
        },
      },
      {
        key: "/",
        desc: "搜索文件",
        group: "Files",
        cmd() {
          void search()
        },
      },
      {
        key: "y",
        desc: "复制路径",
        group: "Files",
        cmd() {
          void copyPath()
        },
      },
    ],
  }))

  const previewNode = () => preview()
  const previewText = () => {
    const content = previewNode()
    if (!content) return undefined
    if (content.type === "binary") return undefined
    return previewLines(content.content)
  }

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background} flexDirection="column">
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <text fg={theme.text}>
          <b>文件</b>
        </text>
        <text fg={theme.textMuted}>  {dir() || "/"}</text>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="row">
        <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
          <Show when={nodes.loading}>
            <text fg={theme.textMuted}>加载中…</text>
          </Show>
          <Show when={!nodes.loading}>
            <For each={entries()}>
              {(node, i) => {
                const isSelected = () => selected() === i()
                return (
                  <box flexDirection="row" gap={1} paddingTop={0} paddingBottom={0}>
                    <text fg={isSelected() ? theme.primary : theme.textMuted} width={2}>
                      {isSelected() ? "›" : " "}
                    </text>
                    <text fg={node.type === "directory" ? theme.primary : isSelected() ? theme.text : theme.textMuted}>
                      {node.type === "directory" ? "📁" : " "} {node.name}
                    </text>
                  </box>
                )
              }}
            </For>
            <Show when={entries().length === 0}>
              <text fg={theme.textMuted}>（空目录）</text>
            </Show>
          </Show>
        </scrollbox>
        <Show when={previewNode()}>
          <box width={48} flexShrink={0} borderStyle="rounded" borderColor={theme.border} backgroundColor={theme.backgroundPanel}>
            <Show when={previewText()} fallback={<text fg={theme.textMuted}>（二进制/不可预览）</text>}>
              <scrollbox flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
                <For each={previewText()}>
                  {(line) => (
                    <text fg={theme.text}>
                      {line || " "}
                    </text>
                  )}
                </For>
              </scrollbox>
            </Show>
          </box>
        </Show>
      </box>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.textMuted}>
          ↑/↓ 选择 · Enter 进入/预览 · ← 上级 · / 搜索 · y 复制路径 · Esc 返回
        </text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <FilesView api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "files.show",
        title: "文件浏览",
        slashName: "files",
        slashAliases: ["explorer", "tree"],
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
  id: "files",
  tui,
}
