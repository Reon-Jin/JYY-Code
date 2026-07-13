import type { GitHubAvailability, GitHubPullRequestDetail, GitHubPullRequestSummary } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PullRequestDialogView } from "./pull-request-dialog"

const available: GitHubAvailability = {
  available: true,
  repository: { nameWithOwner: "example/demo", url: "https://github.com/example/demo", defaultBranch: "main" },
}
const pulls: GitHubPullRequestSummary[] = [
  {
    number: 7,
    title: "Desktop inspector",
    state: "OPEN",
    isDraft: false,
    headRefName: "feature",
    baseRefName: "main",
    author: { login: "codex" },
    reviewDecision: "APPROVED",
    updatedAt: "2026-07-13T00:00:00Z",
    url: "https://github.com/example/demo/pull/7",
  },
]
const detail: GitHubPullRequestDetail = {
  ...pulls[0]!,
  body: "Safe plain text",
  mergeable: "MERGEABLE",
  checks: [
    { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "build", status: "IN_PROGRESS" },
  ],
  commits: [
    { oid: "123456789", messageHeadline: "Add inspector", authoredDate: "2026-07-13", authors: [{ login: "codex" }] },
  ],
  comments: [{ id: "c1", body: "Looks good", author: { login: "reviewer" }, createdAt: "2026-07-13" }],
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
beforeEach(installDialog)
afterEach(cleanup)

function renderView(status: GitHubAvailability = available) {
  const onState = vi.fn()
  const onSelect = vi.fn()
  render(() => (
    <PullRequestDialogView
      open
      status={status}
      pulls={pulls}
      state="open"
      selected={7}
      detail={detail}
      onClose={vi.fn()}
      onRetryStatus={vi.fn()}
      onState={onState}
      onSelect={onSelect}
      onRefresh={vi.fn()}
    />
  ))
  return { onState, onSelect }
}

describe("PullRequestDialog", () => {
  it.each([
    ["missing-gh", "winget install --id GitHub.cli", "GitHub CLI 未安装"],
    ["not-authenticated", "gh auth login", "尚未登录"],
    ["not-github-repo", "git remote -v", "未关联 GitHub"],
  ] as const)("shows recovery for %s", (reason, command, title) => {
    renderView({ available: false, reason, message: title })
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText(command)).toBeVisible()
    expect(within(dialog).getByRole("button", { name: "重新检测" })).toBeVisible()
  })

  it("filters, selects, and renders list metadata plus independent detail data", async () => {
    const user = userEvent.setup()
    const handlers = renderView()
    const dialog = screen.getByRole("dialog", { name: "GitHub Pull Requests" })
    expect(within(dialog).getByText("example/demo")).toBeVisible()
    expect(within(dialog).getByText(/#7 Desktop inspector/)).toBeVisible()
    expect(within(dialog).getByText("feature → main")).toBeVisible()
    expect(within(dialog).getByText("APPROVED")).toBeVisible()
    expect(within(dialog).getByText("Safe plain text")).toBeVisible()
    expect(within(dialog).getByText("SUCCESS")).toBeVisible()
    expect(within(dialog).getByText("Looks good")).toBeVisible()
    await user.click(within(dialog).getByRole("button", { name: "Closed" }))
    expect(handlers.onState).toHaveBeenCalledWith("closed")
    await user.click(within(dialog).getByRole("button", { name: /#7 Desktop inspector/ }))
    expect(handlers.onSelect).toHaveBeenCalledWith(7)
  })
})
