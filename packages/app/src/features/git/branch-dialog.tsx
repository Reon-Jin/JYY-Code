import { tr } from "../../i18n/i18n-context"
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

type BranchEntry = {
  branch: VcsBranch
  name: string
}

function branchDisplayName(branch: VcsBranch) {
  if (branch.kind === "local") return branch.name
  const prefix = branch.remote ? `${branch.remote}/` : ""
  if (prefix && branch.name.startsWith(prefix)) return branch.name.slice(prefix.length)
  return branch.name
}

export function formatBranchUpdatedAt(value?: string, now = Date.now()) {
  if (!value) return undefined
  const updatedAt = Date.parse(value)
  if (!Number.isFinite(updatedAt)) return undefined
  const elapsed = Math.max(0, now - updatedAt)
  const minute = 60 * 1_000
  const hour = 60 * minute
  const day = 24 * hour
  if (elapsed < minute) return tr("git.just")
  if (elapsed < hour) return tr("time.minutes-ago", { count: Math.max(1, Math.round(elapsed / minute)) })
  if (elapsed < day) return tr("time.hours-ago", { count: Math.max(1, Math.round(elapsed / hour)) })
  if (elapsed < 30 * day) return tr("time.days-ago", { count: Math.max(1, Math.round(elapsed / day)) })
  if (elapsed < 365 * day) return tr("time.months-ago", { count: Math.max(1, Math.round(elapsed / (30 * day))) })
  return tr("time.years-ago", { count: Math.max(1, Math.round(elapsed / (365 * day))) })
}

export function BranchDialog(props: BranchDialogProps) {
  const branches = () => {
    const entries: BranchEntry[] = []
    const names = new Set<string>()
    for (const branch of props.branches) {
      if (branch.kind !== "local") continue
      names.add(branch.name)
      entries.push({ branch, name: branch.name })
    }
    for (const branch of props.branches) {
      if (branch.kind !== "remote") continue
      const name = branchDisplayName(branch)
      if (names.has(name)) continue
      names.add(name)
      entries.push({ branch, name })
    }
    const search = props.search.trim().toLowerCase()
    return search ? entries.filter((entry) => entry.name.toLowerCase().includes(search)) : entries
  }

  return (
    <Dialog
      open={props.open}
      class="branch-dialog-modal"
      title={tr("git.git-branch")}
      description={tr("git.switch-branches-or-synchronize-remote-repositories")}
      showClose
      onClose={props.onClose}
    >
      <div class="branch-dialog">
        <label class="branch-search">
          <Search aria-hidden="true" />
          <span>{tr("git.search-branch")}</span>
          <input
            value={props.search}
            placeholder={tr("git.search-branch")}
            onInput={(event) => props.onSearch(event.currentTarget.value)}
          />
        </label>

        <div class="branch-groups">
          <section aria-labelledby="branches-title">
            <h3 id="branches-title">{tr("git.branch")}</h3>
            <ul>
              <For each={branches()} fallback={<li class="branch-empty">{tr("git.no-matching-branch")}</li>}>
                {(entry) => (
                  <li>
                    <button
                      type="button"
                      aria-current={entry.branch.current ? "true" : undefined}
                      disabled={Boolean(props.pending) || entry.branch.current}
                      onClick={() => props.onSwitch(entry.branch)}
                    >
                      <GitFork aria-hidden="true" />
                      <span class="branch-name">{entry.name}</span>
                      <span class="branch-meta">
                        <Show when={formatBranchUpdatedAt(entry.branch.updatedAt)}>
                          {(label) => (
                            <time dateTime={entry.branch.updatedAt} title={new Date(entry.branch.updatedAt!).toLocaleString()}>
                              {label()}
                            </time>
                          )}
                        </Show>
                        <Show when={entry.branch.current}>
                          <strong>{tr("git.current")}</strong>
                        </Show>
                      </span>
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
            <span>{tr("git.new-branch-name")}</span>
            <input value={props.newBranch} onInput={(event) => props.onNewBranch(event.currentTarget.value)} />
          </label>
          <Button type="submit" size="small" variant="secondary" disabled={Boolean(props.pending)}>
            <Plus aria-hidden="true" />
            {tr("git.create-a-new-branch")}
          </Button>
        </form>

        <Show when={props.remotes.length > 1 || props.remote}>
          <label class="branch-remote">
            <span>{tr("git.push-remote")}</span>
            <select value={props.remote ?? ""} onChange={(event) => props.onRemote(event.currentTarget.value)}>
              <option value="">{tr("git.automatic-selection")}</option>
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
