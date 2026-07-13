import { createQuery } from "@tanstack/solid-query"
import { For, Show } from "solid-js"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import { useData } from "../../data/context"
import { parseUnifiedDiff } from "../changes/unified-diff"
import { errorMessage } from "../projects/project-controller"
import { pullRequestDiffQueryOptions } from "./github-query"

export function PullRequestDiffView(props: { patch?: string; loading?: boolean; error?: string }) {
  const diff = () => parseUnifiedDiff(props.patch)
  return (
    <section class="pull-diff" aria-label="Pull Request Diff">
      <Show
        when={!props.loading}
        fallback={
          <p class="pull-detail__state" role="status">
            <Spinner /> 正在加载 Diff
          </p>
        }
      >
        <Show
          when={!props.error}
          fallback={
            <div class="pull-detail__state">
              <InlineError message={props.error!} />
            </div>
          }
        >
          <Show when={diff().hunks.length > 0} fallback={<p class="pull-detail__state">没有可显示的文本 Diff</p>}>
            <pre tabIndex={0} aria-label="Pull Request unified diff">
              <For each={diff().hunks}>
                {(hunk) => (
                  <>
                    <span class="pull-diff__hunk">{hunk.header}</span>
                    <For each={hunk.lines}>
                      {(line) => (
                        <span class="pull-diff__line" data-kind={line.kind}>
                          <span>{line.oldNumber ?? ""}</span>
                          <span>{line.newNumber ?? ""}</span>
                          <span>{line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}</span>
                          <span>{line.content}</span>
                        </span>
                      )}
                    </For>
                  </>
                )}
              </For>
            </pre>
          </Show>
        </Show>
      </Show>
    </section>
  )
}

export function PullRequestDiff(props: { directory: string; number: number }) {
  const data = useData()
  const query = createQuery(
    () => pullRequestDiffQueryOptions({ client: data.client(), directory: props.directory, number: props.number }),
    data.queryClient,
  )
  return (
    <PullRequestDiffView
      patch={query.data}
      loading={query.isPending}
      error={query.error ? errorMessage(query.error, "无法加载 Pull Request Diff") : undefined}
    />
  )
}
