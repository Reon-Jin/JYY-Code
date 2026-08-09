import { tr } from "../../i18n/i18n-context"
import type { VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { FileDiff, RefreshCw } from "lucide-solid"
import { createEffect, createSignal, For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import { useData } from "../../data/context"
import type { FileOpenEvent } from "../files/file-tree"
import { ChangeFile } from "./change-file"
import { changesQueryOptions } from "./changes-query"
import "./changes-panel.css"

export type ChangesPanelViewProps = {
  directory: string
  workspaceID?: string
  sessionID?: string
  mode?: "git" | "session"
  changes?: readonly VcsFileDiff[]
  loading?: boolean
  error?: string
  sharedCompat?: boolean
  onRetry?: () => void
  onOpenFile?: (event: FileOpenEvent) => void
}

export function ChangesPanelView(props: ChangesPanelViewProps) {
  const changes = () => displayableChanges(props.changes)
  const additions = () => changes().reduce((sum, change) => sum + change.additions, 0)
  const deletions = () => changes().reduce((sum, change) => sum + change.deletions, 0)
  const [expandedFiles, setExpandedFiles] = createSignal<ReadonlySet<string>>(new Set())
  let initialized = false

  createEffect(() => {
    const files = changes()
    const available = new Set(files.map((change) => change.file))
    if (!initialized && files.length > 0) {
      initialized = true
      setExpandedFiles(new Set([files[0]!.file]))
      return
    }
    setExpandedFiles((current) => {
      const next = new Set([...current].filter((file) => available.has(file)))
      if (next.size === current.size) return current
      if (next.size === 0 && current.size > 0 && files.length > 0) next.add(files[0]!.file)
      return next
    })
  })

  const toggleFile = (file: string) => {
    setExpandedFiles((current) => {
      const next = new Set(current)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  return (
    <section class="changes-panel" aria-labelledby="changes-panel-title">
      <header class="changes-panel__header">
        <FileDiff aria-hidden="true" />
        <h2 id="changes-panel-title">{tr("changes.workspace-changes")}</h2>
        <Show when={!props.loading && !props.error}>
          <span class="changes-panel__summary">
            {changes().length} {tr("changes.files")}
          </span>
          <span class="changes-panel__totals">
            +{additions()} -{deletions()}
          </span>
        </Show>
      </header>

      <div class="changes-panel__body">
        <Show when={props.sharedCompat}>
          <p class="changes-panel__shared-warning" role="note">
            {tr("changes.shared-workspace-warning")}
          </p>
        </Show>
        <Show
          when={!props.loading}
          fallback={
            <p class="changes-panel__loading" role="status" aria-live="polite">
              <Spinner /> {tr("changes.loading-workspace-changes")}
            </p>
          }
        >
          <Show
            when={!props.error}
            fallback={
              <div class="changes-panel__error">
                <InlineError message={props.error!} />
                <Show when={props.onRetry}>
                  <Button size="small" variant="secondary" onClick={props.onRetry}>
                    <RefreshCw aria-hidden="true" />
                    {tr("changes.try-again")}
                  </Button>
                </Show>
              </div>
            }
          >
            <Show
              when={changes().length > 0}
              fallback={<p class="changes-panel__empty">{tr("changes.the-workspace-has-no-uncommitted-changes")}</p>}
            >
              <ul class="changes-panel__files">
                <For each={changes()}>
                  {(change) => (
                    <ChangeFile
                      change={change}
                      expanded={expandedFiles().has(change.file)}
                      onToggle={() => toggleFile(change.file)}
                      onOpenFile={
                        props.onOpenFile
                          ? (next) =>
                              props.onOpenFile?.({
                                path: next.file,
                                source: "changes",
                                change: next,
                                directory: props.directory,
                                ...(props.workspaceID ? { workspaceID: props.workspaceID } : {}),
                                ...(props.sessionID ? { sessionID: props.sessionID } : {}),
                              })
                          : undefined
                      }
                    />
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </div>
    </section>
  )
}

function displayableChanges(
  changes:
    | readonly VcsFileDiff[]
    | readonly { file?: string; additions: number; deletions: number; patch?: string; status?: VcsFileDiff["status"] }[]
    | undefined,
) {
  return (changes ?? []).flatMap((change) => {
    if (change.file === undefined) return []
    const segments = change.file.replaceAll("\\", "/").split("/")
    if (segments.includes(".jyycode")) return []
    return [{ ...change, file: change.file }]
  })
}

function errorMessage(cause: unknown) {
  return cause instanceof Error && cause.message ? cause.message : tr("changes.unable-to-load-workspace-changes")
}

export function ChangesPanel(props: {
  directory: string
  workspaceID?: string
  sessionID?: string
  mode?: "git" | "session"
  sharedCompat?: boolean
  onOpenFile?: (event: FileOpenEvent) => void
}) {
  const data = useData()
  const query = createQuery(
    () => ({
      ...changesQueryOptions({
        client: data.client(),
        directory: props.directory,
        workspaceID: props.workspaceID,
        sessionID: props.sessionID,
        mode: props.mode ?? "git",
      }),
      enabled: (props.mode ?? "git") === "git" || Boolean(props.sessionID),
    }),
    data.queryClient,
  )

  return (
    <ChangesPanelView
      directory={props.directory}
      workspaceID={props.workspaceID}
      sessionID={props.sessionID}
      mode={props.mode}
      changes={displayableChanges(query.data)}
      loading={query.isPending}
      error={query.error ? errorMessage(query.error) : undefined}
      sharedCompat={props.sharedCompat}
      onRetry={() => void query.refetch()}
      onOpenFile={props.onOpenFile}
    />
  )
}
