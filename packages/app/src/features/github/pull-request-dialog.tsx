import type { GitHubAvailability, GitHubPullRequestDetail, GitHubPullRequestSummary } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { createEffect, createSignal, on, Show } from "solid-js"
import { Dialog } from "../../components/ui/dialog"
import { useData } from "../../data/context"
import { errorMessage } from "../projects/project-controller"
import {
  githubStatusQueryOptions,
  pullRequestQueryOptions,
  pullRequestsQueryOptions,
  type PullRequestState,
} from "./github-query"
import { GitHubStatus } from "./github-status"
import { PullRequestDetailView } from "./pull-request-detail"
import { PullRequestList } from "./pull-request-list"
import "./github.css"

export type PullRequestDialogViewProps = {
  open: boolean
  status?: GitHubAvailability
  statusLoading?: boolean
  statusError?: string
  pulls: readonly GitHubPullRequestSummary[]
  pullsLoading?: boolean
  pullsError?: string
  state: PullRequestState
  selected?: number
  detail?: GitHubPullRequestDetail
  detailLoading?: boolean
  detailError?: string
  onClose: () => void
  onRetryStatus: () => void
  onState: (state: PullRequestState) => void
  onSelect: (number: number) => void
  onRefresh: () => void
}

export function PullRequestDialogView(props: PullRequestDialogViewProps) {
  return (
    <Dialog
      class="pull-request-dialog"
      open={props.open}
      title="GitHub Pull Requests"
      description={
        props.status?.available ? props.status.repository.nameWithOwner : "浏览与管理当前仓库的 Pull Requests"
      }
      onClose={props.onClose}
    >
      <Show
        when={props.status?.available === true}
        fallback={
          <GitHubStatus
            status={props.status}
            loading={props.statusLoading}
            error={props.statusError}
            onRetry={props.onRetryStatus}
          />
        }
      >
        <div class="pull-request-browser">
          <PullRequestList
            pulls={props.pulls}
            state={props.state}
            selected={props.selected}
            loading={props.pullsLoading}
            error={props.pullsError}
            onState={props.onState}
            onSelect={props.onSelect}
            onRefresh={props.onRefresh}
          />
          <PullRequestDetailView detail={props.detail} loading={props.detailLoading} error={props.detailError} />
        </div>
      </Show>
    </Dialog>
  )
}

export function PullRequestDialog(props: { directory: string; open: boolean; onClose: () => void }) {
  const data = useData()
  const [state, setState] = createSignal<PullRequestState>("open")
  const [selected, setSelected] = createSignal<number>()
  const status = createQuery(
    () => ({ ...githubStatusQueryOptions({ client: data.client(), directory: props.directory }), enabled: props.open }),
    data.queryClient,
  )
  const pulls = createQuery(
    () => ({
      ...pullRequestsQueryOptions({ client: data.client(), directory: props.directory, state: state() }),
      enabled: props.open && status.data?.available === true,
    }),
    data.queryClient,
  )
  const detail = createQuery(
    () => ({
      ...pullRequestQueryOptions({ client: data.client(), directory: props.directory, number: selected() ?? 0 }),
      enabled: props.open && Boolean(selected()),
    }),
    data.queryClient,
  )

  createEffect(
    on(
      () => pulls.data,
      (items) => {
        if (!items?.length) return setSelected(undefined)
        if (!selected() || !items.some((pull) => Number(pull.number) === selected()))
          setSelected(Number(items[0]!.number))
      },
    ),
  )

  return (
    <PullRequestDialogView
      open={props.open}
      status={status.data}
      statusLoading={status.isPending}
      statusError={status.error ? errorMessage(status.error, "无法检测 GitHub 环境") : undefined}
      pulls={pulls.data ?? []}
      pullsLoading={pulls.isPending}
      pullsError={pulls.error ? errorMessage(pulls.error, "无法加载 Pull Requests") : undefined}
      state={state()}
      selected={selected()}
      detail={detail.data}
      detailLoading={Boolean(selected()) && detail.isPending}
      detailError={detail.error ? errorMessage(detail.error, "无法加载 Pull Request 详情") : undefined}
      onClose={props.onClose}
      onRetryStatus={() => void status.refetch()}
      onState={setState}
      onSelect={setSelected}
      onRefresh={() => void pulls.refetch()}
    />
  )
}
