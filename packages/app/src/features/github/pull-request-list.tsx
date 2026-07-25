import { tr } from "../../i18n/i18n-context"
import type { GitHubPullRequestSummary } from "@jyycode-ai/sdk/v2/client"
import { GitPullRequest, Plus, RefreshCw } from "lucide-solid"
import { For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import type { PullRequestState } from "./github-query"

const filters: Array<{ value: PullRequestState; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
]

function updated(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(date)
}

export function PullRequestList(props: {
  pulls: readonly GitHubPullRequestSummary[]
  state: PullRequestState
  selected?: number
  loading?: boolean
  error?: string
  onState: (state: PullRequestState) => void
  onSelect: (number: number) => void
  onRefresh: () => void
  onCreate?: () => void
}) {
  return (
    <section class="pull-list" aria-label={tr("github.pull-request-list")}>
      <header class="pull-list__toolbar">
        <div class="pull-list__filters" aria-label={tr("github.pull-request-status")}>
          <For each={filters}>
            {(filter) => (
              <button
                type="button"
                aria-pressed={props.state === filter.value}
                onClick={() => props.onState(filter.value)}
              >
                {filter.label}
              </button>
            )}
          </For>
        </div>
        <Button size="icon" variant="ghost" aria-label={tr("github.refresh-pull-requests")} onClick={props.onRefresh}>
          <RefreshCw aria-hidden="true" />
        </Button>
        <Show when={props.onCreate}>
          <Button size="icon" variant="ghost" aria-label={tr("github.create-pull-request")} onClick={props.onCreate}>
            <Plus aria-hidden="true" />
          </Button>
        </Show>
      </header>
      <Show
        when={!props.loading}
        fallback={
          <p class="pull-list__state" role="status">
            <Spinner /> {tr("github.loading-pull-requests")}
          </p>
        }
      >
        <Show
          when={!props.error}
          fallback={
            <div class="pull-list__state">
              <InlineError message={props.error!} />
            </div>
          }
        >
          <Show
            when={props.pulls.length > 0}
            fallback={<p class="pull-list__state">{tr("github.there-is-no-pull-request-for-the-current")}</p>}
          >
            <ul>
              <For each={props.pulls}>
                {(pull) => (
                  <li>
                    <button
                      type="button"
                      data-selected={props.selected === Number(pull.number) ? "true" : "false"}
                      onClick={() => props.onSelect(Number(pull.number))}
                    >
                      <GitPullRequest aria-hidden="true" />
                      <span class="pull-list__title">
                        <b>
                          #{pull.number} {pull.title}
                        </b>
                        <small>
                          {pull.headRefName} → {pull.baseRefName}
                        </small>
                      </span>
                      <span class="pull-list__meta">
                        <strong data-state={pull.state}>{pull.isDraft ? "Draft" : pull.state}</strong>
                        <small>{pull.reviewDecision ?? "No review"}</small>
                        <time dateTime={pull.updatedAt}>{updated(pull.updatedAt)}</time>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </section>
  )
}
