import type { FileNode, VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, RefreshCw } from "lucide-solid"
import { For, Show, createSignal, type JSX } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import { useData } from "../../data/context"
import { tr } from "../../i18n/i18n-context"
import { isHiddenFileNode } from "./file-types"
import { fileListQueryOptions } from "./file-query"
import "./file-tree.css"

export type FileOpenEvent = {
  path: string
  source: "files" | "changes"
  change?: VcsFileDiff
  directory?: string
  workspaceID?: string
  sessionID?: string
}

export type FileTreeProps = {
  directory: string
  workspaceID?: string
  sessionID?: string
  selectedPath?: string
  onOpenFile?: (event: FileOpenEvent) => void
}

type TreeStateProps = {
  directory: string
  workspaceID?: string
  sessionID?: string
  nodes: readonly FileNode[]
  selectedPath?: string
  onOpenFile?: (event: FileOpenEvent) => void
  loading?: boolean
  error?: unknown
  onRetry?: () => void
}

function visibleNodes(nodes: readonly FileNode[]) {
  return nodes
    .filter((node) => !isHiddenFileNode(node))
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === "directory" ? -1 : 1
      return left.name.localeCompare(right.name)
    })
}

function errorText(error: unknown) {
  return error instanceof Error && error.message ? error.message : tr("files.unable-to-load")
}

function FileTreeNode(props: {
  node: FileNode
  directory: string
  workspaceID?: string
  sessionID?: string
  depth: number
  position: number
  setSize: number
  selectedPath?: string
  onOpenFile?: (event: FileOpenEvent) => void
}) {
  const data = useData()
  const [open, setOpen] = createSignal(false)
  const children = createQuery(
    () => ({
      ...fileListQueryOptions({
        client: data.client(),
        directory: props.directory,
        workspaceID: props.workspaceID,
        sessionID: props.sessionID,
        relativePath: props.node.path,
      }),
      enabled: open(),
    }),
    data.queryClient,
  )
  const nodes = () => visibleNodes(children.data ?? [])
  const isDirectory = () => props.node.type === "directory"

  const activate = () => {
    if (isDirectory()) {
      setOpen((value) => !value)
      return
    }
    props.onOpenFile?.({
      path: props.node.path,
      source: "files",
      directory: props.directory,
      ...(props.workspaceID ? { workspaceID: props.workspaceID } : {}),
      ...(props.sessionID ? { sessionID: props.sessionID } : {}),
    })
  }

  const keydown: JSX.EventHandlerUnion<HTMLButtonElement, KeyboardEvent> = (event) => {
    if (!isDirectory()) return
    if (event.key === "ArrowRight" && !open()) {
      event.preventDefault()
      setOpen(true)
    }
    if (event.key === "ArrowLeft" && open()) {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <li
      class="file-tree__item"
      role="treeitem"
      aria-level={props.depth}
      aria-posinset={props.position}
      aria-setsize={props.setSize}
      aria-expanded={isDirectory() ? open() : undefined}
      aria-selected={props.selectedPath === props.node.path}
    >
      <button
        type="button"
        class="file-tree__node"
        data-kind={props.node.type}
        data-selected={props.selectedPath === props.node.path ? "true" : "false"}
        onClick={activate}
        onKeyDown={keydown}
      >
        <Show when={isDirectory()} fallback={<span class="file-tree__disclosure" aria-hidden="true" />}>
          <span class="file-tree__disclosure" aria-hidden="true">
            <Show when={open()} fallback={<ChevronRight />}>
              <ChevronDown />
            </Show>
          </span>
        </Show>
        <Show when={isDirectory()} fallback={<File aria-hidden="true" />}>
          <Show when={open()} fallback={<Folder aria-hidden="true" />}>
            <FolderOpen aria-hidden="true" />
          </Show>
        </Show>
        <span class="file-tree__name">{props.node.name}</span>
      </button>
      <Show when={isDirectory() && open()}>
        <ul class="file-tree__children" role="group">
          <Show
            when={!children.isPending && !children.error}
            fallback={
              <li class="file-tree__state" role="status">
                <Show when={children.isPending} fallback={<InlineError message={errorText(children.error)} />}>
                  <Spinner /> {tr("files.loading")}
                </Show>
              </li>
            }
          >
            <Show when={nodes().length > 0} fallback={<li class="file-tree__state">{tr("files.empty")}</li>}>
              <For each={nodes()}>
                {(node, index) => (
                  <FileTreeNode
                    node={node}
                    directory={props.directory}
                    workspaceID={props.workspaceID}
                    sessionID={props.sessionID}
                    depth={props.depth + 1}
                    position={index() + 1}
                    setSize={nodes().length}
                    selectedPath={props.selectedPath}
                    onOpenFile={props.onOpenFile}
                  />
                )}
              </For>
            </Show>
          </Show>
        </ul>
      </Show>
    </li>
  )
}

export function FileTreeView(props: TreeStateProps) {
  const nodes = () => visibleNodes(props.nodes)
  return (
    <section class="file-tree" aria-labelledby="file-tree-title">
      <header class="file-tree__header">
        <Folder aria-hidden="true" />
        <h2 id="file-tree-title">{tr("files.title")}</h2>
        <Show when={props.onRetry}>
          <Button
            class="file-tree__refresh"
            size="icon"
            variant="ghost"
            aria-label={tr("files.refresh")}
            onClick={props.onRetry}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </Show>
      </header>
      <Show
        when={!props.loading && !props.error}
        fallback={
          <div class="file-tree__state" role="status">
            <Show when={props.loading} fallback={<InlineError message={errorText(props.error)} />}>
              <Spinner /> {tr("files.loading")}
            </Show>
          </div>
        }
      >
        <Show when={nodes().length > 0} fallback={<p class="file-tree__state">{tr("files.empty")}</p>}>
          <ul class="file-tree__nodes" role="tree" aria-labelledby="file-tree-title">
            <For each={nodes()}>
              {(node, index) => (
                <FileTreeNode
                  node={node}
                  directory={props.directory}
                  workspaceID={props.workspaceID}
                  sessionID={props.sessionID}
                  depth={1}
                  position={index() + 1}
                  setSize={nodes().length}
                  selectedPath={props.selectedPath}
                  onOpenFile={props.onOpenFile}
                />
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  )
}

export function FileTree(props: FileTreeProps) {
  const data = useData()
  const [selectedPath, setSelectedPath] = createSignal(props.selectedPath)
  const query = createQuery(
    () =>
      fileListQueryOptions({
        client: data.client(),
        directory: props.directory,
        workspaceID: props.workspaceID,
        sessionID: props.sessionID,
      }),
    data.queryClient,
  )
  const openFile = (event: FileOpenEvent) => {
    setSelectedPath(event.path)
    props.onOpenFile?.(event)
  }

  return (
    <FileTreeView
      directory={props.directory}
      workspaceID={props.workspaceID}
      sessionID={props.sessionID}
      nodes={query.data ?? []}
      selectedPath={selectedPath()}
      loading={query.isPending}
      error={query.error}
      onRetry={() => void query.refetch()}
      onOpenFile={openFile}
    />
  )
}
