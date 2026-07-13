import type { GitHubPullRequestCheck, GitHubPullRequestDetail as Detail } from "@jyycode-ai/sdk/v2/client"
import { CheckCircle2, CircleDashed, CircleX, Clock3, GitCommit, MessageSquare } from "lucide-solid"
import { For, Match, Show, Switch } from "solid-js"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"

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

export function PullRequestDetailView(props: { detail?: Detail; loading?: boolean; error?: string }) {
  return (
    <section class="pull-detail" aria-label="Pull Request 详情">
      <Show
        when={!props.loading}
        fallback={
          <p class="pull-detail__state" role="status">
            <Spinner /> 正在加载详情
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
          <Show when={props.detail} fallback={<p class="pull-detail__state">从左侧选择 Pull Request</p>}>
            {(pull) => (
              <>
                <header class="pull-detail__header">
                  <span>
                    #{pull().number} · {pull().state}
                    {pull().isDraft ? " · Draft" : ""}
                  </span>
                  <h3>{pull().title}</h3>
                  <p>
                    由 {pull().author.name ?? pull().author.login} 提交 · {pull().headRefName} → {pull().baseRefName}
                  </p>
                </header>
                <div class="pull-detail__body">
                  <section>
                    <h4>说明</h4>
                    <p class="pull-detail__markdown">{pull().body || "未填写说明"}</p>
                  </section>
                  <section>
                    <h4>合并状态</h4>
                    <p>
                      {pull().mergeable || "UNKNOWN"} · {pull().reviewDecision ?? "No review decision"}
                    </p>
                  </section>
                  <section>
                    <h4>Checks</h4>
                    <Show when={pull().checks.length} fallback={<p>没有 Checks</p>}>
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
                    <Show when={pull().commits.length} fallback={<p>没有 Commit 信息</p>}>
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
                    <Show when={pull().comments.length} fallback={<p>暂无评论</p>}>
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
                </div>
              </>
            )}
          </Show>
        </Show>
      </Show>
    </section>
  )
}
