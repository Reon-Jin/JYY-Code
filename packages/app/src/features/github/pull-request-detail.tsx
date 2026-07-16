import { tr } from "../../i18n/i18n-context"
import type { GitHubPullRequestCheck, GitHubPullRequestDetail as Detail } from "@jyycode-ai/sdk/v2/client"
import { CheckCircle2, CircleDashed, CircleX, Clock3, GitCommit, MessageSquare } from "lucide-solid"
import { createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import { renderMarkdown } from "../conversation/markdown"
import { PullRequestActions, type PullRequestActionHandlers } from "./pull-request-actions"

function checkState(check: GitHubPullRequestCheck) {
  const status = check.status.toLowerCase()
  const conclusion = check.conclusion?.toLowerCase()
  if (status === "queued" || status === "pending") return "queued"
  if (status === "in_progress" || status === "in-progress") return "in-progress"
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") return "success"
  if (conclusion === "cancelled") return "cancelled"
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "action_required") return "failure"
  return "unknown"
}

function CheckIcon(props: { state: string }) {
  return (
    <Switch fallback={<CircleDashed aria-hidden="true" />}>
      <Match when={props.state === "success"}>
        <CheckCircle2 aria-hidden="true" />
      </Match>
      <Match when={props.state === "failure" || props.state === "cancelled"}>
        <CircleX aria-hidden="true" />
      </Match>
      <Match when={props.state === "queued" || props.state === "in-progress"}>
        <Clock3 aria-hidden="true" />
      </Match>
    </Switch>
  )
}

export function PullRequestDetailView(props: {
  detail?: Detail
  loading?: boolean
  error?: string
  diff?: JSX.Element
  handlers?: PullRequestActionHandlers
  onEdit?: () => void
}) {
  const [tab, setTab] = createSignal<"overview" | "diff">("overview")
  return (
    <section class="pull-detail" aria-label={tr("github.pull-request-details")}>
      <Show
        when={!props.loading}
        fallback={
          <p class="pull-detail__state" role="status">
            <Spinner /> {tr("github.loading-details")}
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
          <Show when={props.detail} fallback={<p class="pull-detail__state">{tr("github.select-pull-request-from-the-left")}</p>}>
            {(pull) => (
              <>
                <header class="pull-detail__header">
                  <span>
                    #{pull().number} · {pull().state}
                    {pull().isDraft ? " · Draft" : ""}
                  </span>
                  <div class="pull-detail__title">
                    <h3>{pull().title}</h3>
                    <Show when={props.onEdit}>
                      <Button size="small" variant="ghost" onClick={props.onEdit}>
                        {tr("github.edit")}
                      </Button>
                    </Show>
                  </div>
                  <p>
                    {tr("github.depend-on")} {pull().author.name ?? pull().author.login} {tr("github.submit")} {pull().headRefName} → {pull().baseRefName}
                  </p>
                  <div class="pull-detail__tabs" aria-label={tr("github.pull-request-details-view")}>
                    <button type="button" aria-pressed={tab() === "overview"} onClick={() => setTab("overview")}>
                      Overview
                    </button>
                    <button type="button" aria-pressed={tab() === "diff"} onClick={() => setTab("diff")}>
                      Diff
                    </button>
                  </div>
                </header>
                <Show
                  when={tab() === "overview"}
                  fallback={props.diff ?? <p class="pull-detail__state">{tr("github.diff-is-not-available-yet")}</p>}
                >
                  <div class="pull-detail__body">
                    <section>
                      <h4>{tr("github.illustrate")}</h4>
                      <div
                        class="pull-detail__markdown conversation-markdown"
                        innerHTML={renderMarkdown(pull().body || tr("github.no-description-filled-in"))}
                      />
                    </section>
                    <section>
                      <h4>{tr("github.merge-status")}</h4>
                      <p>
                        {pull().mergeable || "UNKNOWN"} · {pull().reviewDecision ?? "No review decision"}
                      </p>
                    </section>
                    <section>
                      <h4>Checks</h4>
                      <Show when={pull().checks.length} fallback={<p>{tr("github.no-checks")}</p>}>
                        <ul class="pull-checks">
                          <For each={pull().checks}>
                            {(check) => {
                              const state = () => checkState(check)
                              return (
                                <li data-state={state()}>
                                  <CheckIcon state={state()} />
                                  <span>{check.name}</span>
                                  <small>{check.conclusion ?? check.status}</small>
                                </li>
                              )
                            }}
                          </For>
                        </ul>
                      </Show>
                    </section>
                    <section>
                      <h4>
                        <GitCommit aria-hidden="true" /> Commits
                      </h4>
                      <Show when={pull().commits.length} fallback={<p>{tr("github.no-commit-information")}</p>}>
                        <ul class="pull-detail__items">
                          <For each={pull().commits}>
                            {(commit) => (
                              <li>
                                <code>{commit.oid.slice(0, 7)}</code>
                                <span>{commit.messageHeadline}</span>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </section>
                    <section>
                      <h4>
                        <MessageSquare aria-hidden="true" /> Comments
                      </h4>
                      <Show when={pull().comments.length} fallback={<p>{tr("github.no-comments")}</p>}>
                        <ul class="pull-comments">
                          <For each={pull().comments}>
                            {(comment) => (
                              <li>
                                <strong>{comment.author.name ?? comment.author.login}</strong>
                                <p>{comment.body}</p>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </section>
                    <Show when={props.handlers}>
                      <PullRequestActions detail={pull()} handlers={props.handlers!} />
                    </Show>
                  </div>
                </Show>
              </>
            )}
          </Show>
        </Show>
      </Show>
    </section>
  )
}
