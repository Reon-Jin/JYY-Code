import { tr } from "../../i18n/i18n-context"
import type { VcsBranch, VcsBranches } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { GitBranch } from "lucide-solid"
import { createMemo, createSignal } from "solid-js"
import { Button } from "../../components/ui/button"
import { useData } from "../../data/context"
import { PullRequestDialog } from "../github/pull-request-dialog"
import { createGitApi, vcsBranchesQueryOptions, vcsInfoQueryOptions } from "./git-query"
import { BranchDialog } from "./branch-dialog"
import "./git.css"

type BranchActions = {
  createBranch: (value: { name: string; checkout?: boolean }) => Promise<VcsBranches>
  switchBranch: (value: { name: string; createLocal?: boolean }) => Promise<VcsBranches>
  fetch: () => Promise<VcsBranches>
  push: (value?: { remote?: string }) => Promise<VcsBranches>
}

export type BranchControlViewProps = {
  current?: string
  branches: VcsBranches
  loading?: boolean
  loadError?: string
  actions: BranchActions
  onPullRequests?: () => void
}

function operationError(cause: unknown) {
  const value = cause as {
    message?: string
    data?: { message?: string; reason?: string; candidates?: string[] }
    error?: { data?: { message?: string; reason?: string; candidates?: string[] } }
  }
  const data = value?.data ?? value?.error?.data
  return {
    message: data?.message ?? value?.message ?? tr("git.git-operation-failed"),
    reason: data?.reason,
    candidates: data?.candidates,
  }
}

function validBranchName(name: string) {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) &&
    !name.includes("..") &&
    !name.includes("@{") &&
    !name.endsWith(".") &&
    !name.endsWith("/") &&
    !name.includes("//")
  )
}

export function BranchControlView(props: BranchControlViewProps) {
  const [open, setOpen] = createSignal(false)
  const [search, setSearch] = createSignal("")
  const [newBranch, setNewBranch] = createSignal("")
  const [remote, setRemote] = createSignal<string>()
  const [pending, setPending] = createSignal<string>()
  const [feedback, setFeedback] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const isGit = () => Boolean(props.current)

  async function run(name: string, action: () => Promise<unknown>, success: string) {
    if (pending()) return
    setPending(name)
    setError(undefined)
    setFeedback(undefined)
    try {
      await action()
      setFeedback(success)
    } catch (cause) {
      const failure = operationError(cause)
      if (failure.reason === "ambiguous-remote" && failure.candidates?.length) {
        setError(tr("git.multiple-remote-ends-detected-please-select-the-push"))
      } else if (failure.reason === "conflict") {
        setError(tr("git.commit-or-stash-before-retry", { reason: failure.message }))
      } else {
        setError(failure.message)
      }
    } finally {
      setPending(undefined)
    }
  }

  function switchBranch(branch: VcsBranch) {
    void run(
      "switch",
      () => props.actions.switchBranch({ name: branch.name, createLocal: branch.kind === "remote" }),
      tr("git.switched-to-branch", { branch: branch.name }),
    )
  }

  function createBranch() {
    const name = newBranch().trim()
    if (!name) {
      setError(tr("git.please-enter-a-branch-name"))
      return
    }
    if (!validBranchName(name)) {
      setError(tr("git.branch-name-contains-characters-or-path-fragments-that"))
      return
    }
    void run(
      "create",
      () => props.actions.createBranch({ name, checkout: true }),
      tr("git.created-and-switched", { branch: name }),
    ).then(() => {
      if (!error()) setNewBranch("")
    })
  }

  return (
    <div class="branch-control">
      <Button
        class="branch-control__trigger"
        size="small"
        variant="secondary"
        disabled={props.loading || !isGit()}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <GitBranch aria-hidden="true" />
        <span>
          {props.loading ? tr("git.checking-repository") : (props.current ?? tr("git.version-control-is-not-enabled"))}
        </span>
      </Button>
      <BranchDialog
        open={open()}
        branches={props.branches.branches}
        remotes={props.branches.remotes}
        search={search()}
        newBranch={newBranch()}
        remote={remote()}
        pending={pending()}
        feedback={feedback()}
        error={error() ?? props.loadError}
        onClose={() => setOpen(false)}
        onSearch={setSearch}
        onNewBranch={setNewBranch}
        onRemote={(value) => setRemote(value || undefined)}
        onSwitch={switchBranch}
        onCreate={createBranch}
        onFetch={() => void run("fetch", props.actions.fetch, tr("git.fetch-completed"))}
        onPush={() =>
          void run("push", () => props.actions.push(remote() ? { remote: remote() } : {}), tr("git.push-completed"))
        }
        onPullRequests={
          props.onPullRequests
            ? () => {
                setOpen(false)
                props.onPullRequests?.()
              }
            : undefined
        }
      />
    </div>
  )
}

export function BranchControl(props: { directory: string; onPullRequests?: () => void }) {
  const data = useData()
  const info = createQuery(
    () => vcsInfoQueryOptions({ client: data.client(), directory: props.directory }),
    data.queryClient,
  )
  const branches = createQuery(
    () => ({
      ...vcsBranchesQueryOptions({ client: data.client(), directory: props.directory }),
      enabled: Boolean(info.data?.branch),
    }),
    data.queryClient,
  )
  const actions = createMemo(() =>
    createGitApi({ client: data.client(), directory: props.directory, queryClient: data.queryClient() }),
  )
  const [pullRequestsOpen, setPullRequestsOpen] = createSignal(false)

  return (
    <>
      <BranchControlView
        current={branches.data?.current ?? info.data?.branch}
        branches={branches.data ?? { branches: [], remotes: [] }}
        loading={info.isPending || (Boolean(info.data?.branch) && branches.isPending)}
        loadError={
          branches.error
            ? tr("git.load-branches-failed", { reason: operationError(branches.error).message })
            : undefined
        }
        actions={actions()}
        onPullRequests={props.onPullRequests ?? (() => setPullRequestsOpen(true))}
      />
      <PullRequestDialog
        directory={props.directory}
        open={pullRequestsOpen()}
        onClose={() => setPullRequestsOpen(false)}
      />
    </>
  )
}
