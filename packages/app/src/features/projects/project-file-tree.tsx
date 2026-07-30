import type { FileNode } from "@jyycode-ai/sdk/v2/client"
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, LoaderCircle } from "lucide-solid"
import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import type { DesktopClient } from "../../data/sdk"

type ProjectFileTreeProps = {
  client: Pick<DesktopClient, "file">
  directory: string
}

function nodeKey(path: string) {
  return path || "."
}

export function ProjectFileTree(props: ProjectFileTreeProps) {
  const [entries, setEntries] = createSignal<Record<string, readonly FileNode[]>>({})
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set([nodeKey("")]))
  const [loading, setLoading] = createSignal<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = createSignal(false)

  async function load(path: string) {
    const key = nodeKey(path)
    if (entries()[key] || loading().has(key)) return
    setLoading((current) => new Set(current).add(key))
    try {
      const result = await props.client.file.list({ directory: props.directory, path }, { throwOnError: true })
      setEntries((current) => ({ ...current, [key]: result.data.filter((node) => !node.ignored) }))
    } catch {
      setFailed(true)
    } finally {
      setLoading((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  function toggle(node: FileNode) {
    const key = nodeKey(node.path)
    if (expanded().has(key)) {
      setExpanded((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
      return
    }
    setExpanded((current) => new Set(current).add(key))
    void load(node.path)
  }

  function rows(path: string, depth: number): JSX.Element {
    const key = nodeKey(path)
    return (
      <For each={entries()[key] ?? []}>
        {(node) => {
          const isDirectory = node.type === "directory"
          const open = () => expanded().has(nodeKey(node.path))
          return (
            <li>
              <button
                type="button"
                class="project-file-tree__row"
                style={{ "--tree-depth": String(depth) }}
                data-directory={isDirectory ? "true" : "false"}
                aria-expanded={isDirectory ? open() : undefined}
                onClick={() => isDirectory && toggle(node)}
              >
                <Show when={isDirectory} fallback={<span class="project-file-tree__chevron" />}>
                  <Show when={open()} fallback={<ChevronRight aria-hidden="true" />}>
                    <ChevronDown aria-hidden="true" />
                  </Show>
                </Show>
                <Show when={isDirectory} fallback={<FileText aria-hidden="true" />}>
                  <Show when={open()} fallback={<Folder aria-hidden="true" />}>
                    <FolderOpen aria-hidden="true" />
                  </Show>
                </Show>
                <span title={node.path}>{node.name}</span>
                <Show when={isDirectory && loading().has(nodeKey(node.path))}>
                  <LoaderCircle class="project-file-tree__loading" aria-label="正在读取目录" />
                </Show>
              </button>
              <Show when={isDirectory && open()}><ul>{rows(node.path, depth + 1)}</ul></Show>
            </li>
          )
        }}
      </For>
    )
  }

  onMount(() => void load(""))

  return (
    <section class="project-file-tree" aria-label="项目文件目录">
      <header><Folder aria-hidden="true" /><strong>项目文件</strong></header>
      <Show when={!failed()} fallback={<p>目录暂时无法读取。</p>}>
        <ul>{rows("", 0)}</ul>
      </Show>
    </section>
  )
}
