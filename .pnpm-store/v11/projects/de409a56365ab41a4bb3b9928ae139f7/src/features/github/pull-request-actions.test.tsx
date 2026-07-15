import type { GitHubPullRequestDetail } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PullRequestActions, type PullRequestActionHandlers } from "./pull-request-actions"
import { PullRequestDiffView } from "./pull-request-diff"
import { PullRequestForm } from "./pull-request-form"

const detail: GitHubPullRequestDetail = {
  number: 12,
  title: "Inspector",
  state: "OPEN",
  isDraft: false,
  headRefName: "feature/inspector",
  baseRefName: "main",
  author: { login: "codex" },
  updatedAt: "2026-07-13",
  url: "https://github.com/example/demo/pull/12",
  body: "body",
  mergeable: "MERGEABLE",
  comments: [],
  commits: [],
  checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
}

function installDialog() {
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open")
      },
    },
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "")
      },
    },
  })
}

function handlers(overrides?: Partial<PullRequestActionHandlers>): PullRequestActionHandlers {
  return {
    comment: vi.fn(async () => {}),
    checkout: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    reopen: vi.fn(async () => {}),
    merge: vi.fn(async () => {}),
    ...overrides,
  }
}

beforeEach(installDialog)
afterEach(cleanup)

describe("PullRequestForm", () => {
  it("validates create fields and submits draft without changing branch fields during edit", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(async () => {})
    render(() => <PullRequestForm mode="create" onSubmit={onSubmit} onCancel={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: "创建" }))
    expect(screen.getByRole("alert")).toHaveTextContent("标题、Head 和 Base")
    await user.type(screen.getByLabelText("标题"), "New PR")
    await user.type(screen.getByLabelText("Head"), "feature/new")
    await user.click(screen.getByLabelText("创建为 Draft"))
    await user.click(screen.getByRole("button", { name: "创建" }))
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ title: "New PR", head: "feature/new", base: "main", draft: true }),
      ),
    )
  })
})

describe("PullRequestActions", () => {
  it("comments, checks out, closes, and confirms an explicit merge method", async () => {
    const user = userEvent.setup()
    const action = handlers()
    render(() => <PullRequestActions detail={detail} handlers={action} />)
    await user.click(screen.getByRole("button", { name: "评论" }))
    expect(screen.getByRole("alert")).toHaveTextContent("评论不能为空")
    const comment = screen.getByLabelText("添加评论")
    await user.type(comment, "Ship it")
    await user.click(screen.getByRole("button", { name: "评论" }))
    await waitFor(() => expect(action.comment).toHaveBeenCalledWith("Ship it"))
    expect(comment).toHaveValue("")
    await user.click(screen.getByRole("button", { name: /Checkout feature\/inspector/ }))
    expect(action.checkout).toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(action.close).toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Merge" }))
    const dialog = screen.getByRole("dialog", { name: "合并 #12" })
    expect(within(dialog).getByText(/feature\/inspector → main/)).toBeVisible()
    await user.click(within(dialog).getByLabelText("Rebase"))
    await user.click(within(dialog).getByLabelText("合并后删除远程分支"))
    await user.click(within(dialog).getByRole("button", { name: "确认合并" }))
    await waitFor(() => expect(action.merge).toHaveBeenCalledWith("rebase", true))
  })

  it("shows only valid state actions and keeps failed comment input", async () => {
    const user = userEvent.setup()
    const action = handlers({
      comment: vi.fn(async () => {
        throw new Error("network unavailable")
      }),
    })
    const { unmount } = render(() => <PullRequestActions detail={{ ...detail, state: "CLOSED" }} handlers={action} />)
    expect(screen.getByRole("button", { name: "Reopen" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText("添加评论"), "Keep this")
    await user.click(screen.getByRole("button", { name: "评论" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("network unavailable")
    expect(screen.getByLabelText("添加评论")).toHaveValue("Keep this")
    unmount()
    render(() => <PullRequestActions detail={{ ...detail, state: "MERGED" }} handlers={handlers()} />)
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Reopen" })).not.toBeInTheDocument()
  })

  it("blocks merge for drafts, failed checks, and unmergeable state", () => {
    render(() => <PullRequestActions detail={{ ...detail, isDraft: true }} handlers={handlers()} />)
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled()
    expect(screen.getByText("Draft PR 不能合并")).toBeVisible()
  })

  it.each(["required checks failed", "permission denied", "branch protection", "network error"])(
    "keeps merge confirmation state after %s",
    async (message) => {
      const user = userEvent.setup()
      const action = handlers({
        merge: vi.fn(async () => {
          throw new Error(message)
        }),
      })
      render(() => <PullRequestActions detail={detail} handlers={action} />)
      await user.click(screen.getByRole("button", { name: "Merge" }))
      const dialog = screen.getByRole("dialog", { name: "合并 #12" })
      await user.click(within(dialog).getByLabelText("Rebase"))
      await user.click(within(dialog).getByLabelText("合并后删除远程分支"))
      await user.click(within(dialog).getByRole("button", { name: "确认合并" }))
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(message)
      expect(dialog).toHaveAttribute("open")
      expect(within(dialog).getByLabelText("Rebase")).toBeChecked()
      expect(within(dialog).getByLabelText("合并后删除远程分支")).toBeChecked()
    },
  )
})

describe("PullRequestDiff", () => {
  it("uses the text diff renderer without interpreting HTML", () => {
    render(() => <PullRequestDiffView patch={"@@ -1 +1 @@\n-safe\n+<img src=x onerror=alert(1)>"} />)
    expect(screen.getByLabelText("Pull Request unified diff")).toHaveTextContent("<img src=x")
    expect(document.querySelector("img")).toBeNull()
  })
})
