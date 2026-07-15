import type { VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { FileDiff, RefreshCw } from "lucide-solid"
import { createEffect, createSignal, For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import { useData } from "../../data/context"
import { ChangeFile } from "./change-file"
import { changesQueryOptions } from "./changes-query"
import "./changes-panel.css"

export type ChangesPanelViewProps = {
  directory: string
  changes?: readonly VcsFileDiff[]
  loading?: boolean
  error?: string
  onRetry?: () => void
}

export function ChangesPanelView(props: ChangesPanelViewProps) {
  const changes = () => props.changes ?? []
  const additions = () => changes().reduce((sum, change) => sum + change.additions, 0)
  const deletions = () => changes().reduce((sum, change) => sum + change.deletions, 0)
  const [selected, setSelected] = createSignal<string>()
  let initialized = false

  createEffect(() => {
    const files = changes()
    if (files.length === 0) return
    if (!initialized) {
      initialized = true
      setSelected(files[0]?.file)
      return
    }
    const current = selected()
    if (current && !files.some((change) => change.file === current)) setSelected(files[0]?.file)
  })

  return (
    <section class="changes-panel" aria-labelledby="changes-panel-title">
      <header class="changes-panel__header">
        <FileDiff aria-hidden="true" />
        <h2 id="changes-panel-title">工作区变更</h2>
        <Show when={!props.loading && !props.error}>
          <span class="changes-panel__summary">{changes().length} 个文件</span>
          <span class="changes-panel__totals">
            +{additions()} -{deletions()}
          </span>
        </Show>
      </header>

      <div class="changes-panel__body">
        <Show
          when={!props.loading}
          fallback={
            <p class="changes-panel__loading" role="status" aria-live="polite">
              <Spinner /> 正在加载工作区变更
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
                    重试
                  </Button>
                </Show>
              </div>
            }
          >
            <Show when={changes().length > 0} fallback={<p class="changes-panel__empty">工作区没有未提交变更</p>}>
              <ul class="changes-panel__files">
                <For each={changes()}>
                  {(change) => (
                    <ChangeFile
                      change={change}
                      expanded={selected() === change.file}
                      onToggle={() => setSelected((current) => (current === change.file ? undefined : change.file))}
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

function errorMessage(cause: unknown) {
  return cause instanceof Error && cause.message ? cause.message : "无法加载工作区变更"
}

export function ChangesPanel(props: { directory: string }) {
  const data = useData()
  const query = createQuery(
    () => changesQueryOptions({ client: data.client(), directory: props.directory }),
    data.queryClient,
  )

  return (
    <ChangesPanelView
      directory={props.directory}
      changes={query.data}
      loading={query.isPending}
      error={query.error ? errorMessage(query.error) : undefined}
      onRetry={() => void query.refetch()}
    />
  )
}
