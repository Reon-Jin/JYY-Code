import type { GitHubAvailability, GitHubPullRequestDetail, GitHubPullRequestSummary } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { ArrowLeft } from "lucide-solid"
import { createEffect, createMemo, createSignal, on, Show, type JSX } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { useData } from "../../data/context"
import { errorMessage } from "../projects/project-controller"
import {
  githubStatusQueryOptions,
  pullRequestQueryOptions,
  pullRequestsQueryOptions,
  createGitHubApi,
  type PullRequestState,
} from "./github-query"
import { GitHubStatus } from "./github-status"
import { PullRequestDetailView } from "./pull-request-detail"
import { PullRequestDiff } from "./pull-request-diff"
import { PullRequestForm, type PullRequestFormValue } from "./pull-request-form"
import { PullRequestList } from "./pull-request-list"
import type { PullRequestActionHandlers } from "./pull-request-actions"
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
  editor?: JSX.Element
  diff?: JSX.Element
  handlers?: PullRequestActionHandlers
  onClose: () => void
  onRetryStatus: () => void
  onState: (state: PullRequestState) => void
  onSelect: (number: number) => void
  onRefresh: () => void
  onCreate?: () => void
  onEdit?: () => void
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
            onCreate={props.onCreate}
          />
          <div class="pull-detail-column">
            <div class="pull-detail-column__toolbar">
              <Button size="small" variant="ghost" onClick={props.onClose}>
                <ArrowLeft aria-hidden="true" />
                返回并关闭
              </Button>
            </div>
            <Show
              when={!props.editor}
              fallback={<section class="pull-detail pull-detail--editor">{props.editor}</section>}
            >
              <PullRequestDetailView
                detail={props.detail}
                loading={props.detailLoading}
                error={props.detailError}
                diff={props.diff}
                handlers={props.handlers}
                onEdit={props.onEdit}
              />
            </Show>
          </div>
        </div>
      </Show>
    </Dialog>
  )
}

export function PullRequestDialog(props: { directory: string; open: boolean; onClose: () => void }) {
  const data = useData()
  const [state, setState] = createSignal<PullRequestState>("open")
  const [selected, setSelected] = createSignal<number>()
  const [editor, setEditor] = createSignal<"create" | "edit">()
  const status = createQuery(
    () => ({ ...githubStatusQueryOptions({ client: data.client(), directory: props.directory }), enabled: props.open }),
    data.queryClient,
  )
  const pulls = createQuery(
    () => ({
      ...pullRequestsQueryOptions({ client: data.client(), directory: props.directory, state: state() }),
      enabled: props.open && !status.isPending && status.data?.available === true,
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
  const api = createMemo(() =>
    createGitHubApi({ client: data.client(), directory: props.directory, queryClient: data.queryClient() }),
  )
  const statusData = () => (status.isPending ? undefined : status.data)
  const pullsData = () => (pulls.isPending ? undefined : pulls.data)
  const detailData = () => (detail.isPending ? undefined : detail.data)

  createEffect(
    on(
      pullsData,
      (items) => {
        if (!items?.length) return setSelected(undefined)
        if (!selected() || !items.some((pull) => Number(pull.number) === selected()))
          setSelected(Number(items[0]!.number))
      },
    ),
  )

  async function saveCreate(value: PullRequestFormValue) {
    const created = await api().create(value)
    setEditor(undefined)
    if (created?.number !== undefined) setSelected(Number(created.number))
  }

  async function saveEdit(value: PullRequestFormValue) {
    const number = selected()
    if (!number) throw new Error("未选择 Pull Request")
    await api().edit({ number, title: value.title, body: value.body })
    setEditor(undefined)
  }

  const handlers = createMemo<PullRequestActionHandlers | undefined>(() => {
    const pull = detailData()
    if (!pull) return undefined
    const number = Number(pull.number)
    return {
      comment: async (body) => {
        await api().comment({ number, body })
      },
      checkout: async () => {
        await api().checkout({ number, branch: pull.headRefName })
      },
      close: async () => {
        await api().close({ number })
      },
      reopen: async () => {
        await api().reopen({ number })
      },
      merge: async (method, deleteBranch) => {
        await api().merge({ number, method, deleteBranch })
      },
    }
  })

  function editorContent() {
    const mode = editor()
    if (!mode) return undefined
    const currentDetail = detailData()
    const currentStatus = statusData()
    return (
      <PullRequestForm
        mode={mode}
        initial={
          mode === "edit" && currentDetail
            ? {
                title: currentDetail.title,
                body: currentDetail.body,
                head: currentDetail.headRefName,
                base: currentDetail.baseRefName,
                draft: currentDetail.isDraft,
              }
            : {
                title: "",
                body: "",
                head: currentDetail?.headRefName ?? "",
                base: currentStatus?.available ? currentStatus.repository.defaultBranch : "main",
              }
        }
        onSubmit={mode === "create" ? saveCreate : saveEdit}
        onCancel={() => setEditor(undefined)}
      />
    )
  }

  return (
    <PullRequestDialogView
      open={props.open}
      status={statusData()}
      statusLoading={status.isPending}
      statusError={status.error ? errorMessage(status.error, "无法检测 GitHub 环境") : undefined}
      pulls={pullsData() ?? []}
      pullsLoading={pulls.isPending}
      pullsError={pulls.error ? errorMessage(pulls.error, "无法加载 Pull Requests") : undefined}
      state={state()}
      selected={selected()}
      detail={detailData()}
      detailLoading={Boolean(selected()) && detail.isPending}
      detailError={detail.error ? errorMessage(detail.error, "无法加载 Pull Request 详情") : undefined}
      editor={editorContent()}
      diff={selected() ? <PullRequestDiff directory={props.directory} number={selected()!} /> : undefined}
      handlers={handlers()}
      onClose={props.onClose}
      onRetryStatus={() => void status.refetch()}
      onState={setState}
      onSelect={setSelected}
      onRefresh={() => void pulls.refetch()}
      onCreate={() => setEditor("create")}
      onEdit={() => setEditor("edit")}
    />
  )
}
