import { tr } from "../../i18n/i18n-context"
import type { GitHubPullRequestDetail } from "@jyycode-ai/sdk/v2/client"
import { GitMerge, GitPullRequestClosed, MessageSquare, RefreshCw } from "lucide-solid"
import { createMemo, createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"

export type MergeMethod = "merge" | "squash" | "rebase"

export type PullRequestActionHandlers = {
  comment: (body: string) => Promise<void>
  checkout: () => Promise<void>
  close: () => Promise<void>
  reopen: () => Promise<void>
  merge: (method: MergeMethod, deleteBranch: boolean) => Promise<void>
}

function errorMessage(cause: unknown) {
  const value = cause as { message?: string; data?: { message?: string } }
  return value?.data?.message ?? value?.message ?? tr("github.pull-request-operation-failed")
}

export function PullRequestActions(props: { detail: GitHubPullRequestDetail; handlers: PullRequestActionHandlers }) {
  const [comment, setComment] = createSignal("")
  const [pending, setPending] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [success, setSuccess] = createSignal<string>()
  const [mergeOpen, setMergeOpen] = createSignal(false)
  const [method, setMethod] = createSignal<MergeMethod>("squash")
  const [deleteBranch, setDeleteBranch] = createSignal(false)
  const failedChecks = createMemo(() =>
    props.detail.checks.some((check) =>
      ["failure", "timed_out", "action_required", "cancelled"].includes(check.conclusion?.toLowerCase() ?? ""),
    ),
  )
  const mergeBlocked = createMemo(
    () => props.detail.isDraft || failedChecks() || props.detail.mergeable.toUpperCase() !== "MERGEABLE",
  )
  const mergeReason = createMemo(() =>
    props.detail.isDraft
      ? tr("github.draft-pr-cannot-be-merged")
      : failedChecks()
        ? tr("github.checks-failed")
        : props.detail.mergeable.toUpperCase() !== "MERGEABLE"
          ? tr("github.cannot-merge-status", { status: props.detail.mergeable })
          : undefined,
  )

  async function run(name: string, action: () => Promise<void>, message: string) {
    if (pending()) return false
    setPending(name)
    setError(undefined)
    setSuccess(undefined)
    try {
      await action()
      setSuccess(message)
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setPending(undefined)
    }
  }

  async function submitComment() {
    const body = comment().trim()
    if (!body) return setError(tr("github.comment-cannot-be-empty"))
    if (await run("comment", () => props.handlers.comment(body), tr("github.comment-posted"))) setComment("")
  }

  async function merge() {
    if (mergeBlocked()) return
    if (await run("merge", () => props.handlers.merge(method(), deleteBranch()), tr("github.pull-request-merged")))
      setMergeOpen(false)
  }

  return (
    <section class="pull-actions" aria-label={tr("github.pull-request-operation")}>
      <div class="pull-actions__commands">
        <Button
          size="small"
          variant="secondary"
          loading={pending() === "checkout"}
          onClick={() =>
            void run(
              "checkout",
              props.handlers.checkout,
              tr("github.checked-out", { branch: props.detail.headRefName }),
            )
          }
        >
          <RefreshCw aria-hidden="true" />
          Checkout {props.detail.headRefName}
        </Button>
        <Show when={props.detail.state === "OPEN"}>
          <Button
            size="small"
            variant="secondary"
            loading={pending() === "close"}
            onClick={() => void run("close", props.handlers.close, tr("github.pull-request-closed"))}
          >
            <GitPullRequestClosed aria-hidden="true" />
            Close
          </Button>
        </Show>
        <Show when={props.detail.state === "CLOSED"}>
          <Button
            size="small"
            variant="secondary"
            loading={pending() === "reopen"}
            onClick={() => void run("reopen", props.handlers.reopen, tr("github.pull-request-has-been-reopened"))}
          >
            Reopen
          </Button>
        </Show>
        <Show when={props.detail.state === "OPEN"}>
          <Button size="small" disabled={mergeBlocked()} title={mergeReason()} onClick={() => setMergeOpen(true)}>
            <GitMerge aria-hidden="true" />
            Merge
          </Button>
        </Show>
      </div>
      <Show when={mergeReason()}>
        <p class="pull-actions__hint">{mergeReason()}</p>
      </Show>
      <form
        class="pull-comment"
        onSubmit={(event) => {
          event.preventDefault()
          void submitComment()
        }}
      >
        <label>
          <span>{tr("github.add-comment")}</span>
          <textarea rows={3} value={comment()} onInput={(event) => setComment(event.currentTarget.value)} />
        </label>
        <Button type="submit" size="small" variant="secondary" loading={pending() === "comment"}>
          <MessageSquare aria-hidden="true" />
          {tr("github.comment")}
        </Button>
      </form>
      <Show when={success()}>
        <p class="pull-actions__success" role="status" aria-live="polite">
          {success()}
        </p>
      </Show>
      <Show when={error()}>
        <InlineError message={error()!} />
      </Show>

      <Dialog
        open={mergeOpen()}
        title={tr("github.merge-number", { number: props.detail.number })}
        description={`${props.detail.headRefName} → ${props.detail.baseRefName} · ${props.detail.title}`}
        onClose={() => setMergeOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setMergeOpen(false)}>
              {tr("github.cancel")}
            </Button>
            <Button loading={pending() === "merge"} onClick={() => void merge()}>
              {tr("github.confirm-merge")}
            </Button>
          </>
        }
      >
        <div class="merge-confirm">
          <fieldset>
            <legend>{tr("github.merge-method")}</legend>
            <label>
              <input
                type="radio"
                name="merge-method"
                checked={method() === "merge"}
                onChange={() => setMethod("merge")}
              />
              Merge commit
            </label>
            <label>
              <input
                type="radio"
                name="merge-method"
                checked={method() === "squash"}
                onChange={() => setMethod("squash")}
              />
              Squash
            </label>
            <label>
              <input
                type="radio"
                name="merge-method"
                checked={method() === "rebase"}
                onChange={() => setMethod("rebase")}
              />
              Rebase
            </label>
          </fieldset>
          <label class="pull-form__checkbox">
            <input
              type="checkbox"
              checked={deleteBranch()}
              onChange={(event) => setDeleteBranch(event.currentTarget.checked)}
            />
            {tr("github.delete-remote-branch-after-merge")}
          </label>
          <Show when={error()}>
            <InlineError message={error()!} />
          </Show>
        </div>
      </Dialog>
    </section>
  )
}
