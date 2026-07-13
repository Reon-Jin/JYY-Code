import type { VcsBranch, VcsRemote } from "@jyycode-ai/sdk/v2/client"
import { GitFork, Plus, RefreshCw, Search, Upload } from "lucide-solid"
import { For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"

export type BranchDialogProps = {
  open: boolean
  branches: readonly VcsBranch[]
  remotes: readonly VcsRemote[]
  search: string
  newBranch: string
  remote?: string
  pending?: string
  feedback?: string
  error?: string
  onClose: () => void
  onSearch: (value: string) => void
  onNewBranch: (value: string) => void
  onRemote: (value: string) => void
  onSwitch: (branch: VcsBranch) => void
  onCreate: () => void
  onFetch: () => void
  onPush: () => void
  onPullRequests?: () => void
}

export function BranchDialog(props: BranchDialogProps) {
  const matches = (branch: VcsBranch) => branch.name.toLowerCase().includes(props.search.trim().toLowerCase())
  const local = () => props.branches.filter((branch) => branch.kind === "local" && matches(branch))
  const remote = () => props.branches.filter((branch) => branch.kind === "remote" && matches(branch))

  return (
    <Dialog open={props.open} title="Git 分支" description="切换分支或同步远程仓库" onClose={props.onClose}>
      <div class="branch-dialog">
        <label class="branch-search">
          <Search aria-hidden="true" />
          <span>搜索分支</span>
          <input
            value={props.search}
            placeholder="搜索本地与远程分支"
            onInput={(event) => props.onSearch(event.currentTarget.value)}
          />
        </label>

        <div class="branch-groups">
          <section aria-labelledby="local-branches-title">
            <h3 id="local-branches-title">本地</h3>
            <ul>
              <For each={local()} fallback={<li class="branch-empty">没有匹配的本地分支</li>}>
                {(branch) => (
                  <li>
                    <button
                      type="button"
                      aria-current={branch.current ? "true" : undefined}
                      disabled={Boolean(props.pending) || branch.current}
                      onClick={() => props.onSwitch(branch)}
                    >
                      <GitFork aria-hidden="true" />
                      <span>{branch.name}</span>
                      <Show when={branch.current}>当前</Show>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>
          <section aria-labelledby="remote-branches-title">
            <h3 id="remote-branches-title">远程</h3>
            <ul>
              <For each={remote()} fallback={<li class="branch-empty">没有匹配的远程分支</li>}>
                {(branch) => (
                  <li>
                    <button type="button" disabled={Boolean(props.pending)} onClick={() => props.onSwitch(branch)}>
                      <GitFork aria-hidden="true" />
                      <span>{branch.name}</span>
                      <small>创建本地跟踪分支</small>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </div>

        <form
          class="branch-create"
          onSubmit={(event) => {
            event.preventDefault()
            props.onCreate()
          }}
        >
          <label>
            <span>新分支名称</span>
            <input value={props.newBranch} onInput={(event) => props.onNewBranch(event.currentTarget.value)} />
          </label>
          <Button type="submit" size="small" variant="secondary" disabled={Boolean(props.pending)}>
            <Plus aria-hidden="true" />
            新建分支
          </Button>
        </form>

        <Show when={props.remotes.length > 1 || props.remote}>
          <label class="branch-remote">
            <span>Push 远端</span>
            <select value={props.remote ?? ""} onChange={(event) => props.onRemote(event.currentTarget.value)}>
              <option value="">自动选择</option>
              <For each={props.remotes}>{(item) => <option value={item.name}>{item.name}</option>}</For>
            </select>
          </label>
        </Show>

        <div class="branch-actions">
          <Button size="small" variant="secondary" loading={props.pending === "fetch"} onClick={props.onFetch}>
            <RefreshCw aria-hidden="true" />
            Fetch
          </Button>
          <Button size="small" variant="secondary" loading={props.pending === "push"} onClick={props.onPush}>
            <Upload aria-hidden="true" />
            Push
          </Button>
          <Show when={props.onPullRequests}>
            <Button size="small" variant="secondary" onClick={props.onPullRequests}>
              Pull Requests
            </Button>
          </Show>
        </div>

        <Show when={props.feedback}>
          <p class="branch-feedback" role="status" aria-live="polite">
            {props.feedback}
          </p>
        </Show>
        <Show when={props.error}>
          <InlineError message={props.error!} />
        </Show>
      </div>
    </Dialog>
  )
}
