import type { SessionBlackboardResponse } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DataProvider } from "../../data/context"
import { createFakeJyycode } from "../../test/fake-jyycode"
import { BlackboardPanel } from "./blackboard-panel"

const directory = "C:\\work\\demo"

function board(rootSessionID: string): SessionBlackboardResponse {
  return {
    rootSessionID,
    currentStepID: "step_2",
    selectedStepID: "step_2",
    readonly: false,
    tasks: [
      { id: "task_a", title: "Investigate", status: "running", hasAgent: true, isSelf: false },
      { id: "task_b", title: "Verify", status: "pending", hasAgent: false, isSelf: false },
    ],
    messages: [
      {
        id: "bb_old",
        rootSessionID,
        stepID: "step_1",
        authorKind: "sub_agent",
        authorTaskID: "task_a",
        kind: "info",
        body: "Old step",
        mentions: [],
        attachments: [],
        taskIDs: ["task_a"],
        timeCreated: 1,
        replies: [],
      },
      {
        id: "bb_current",
        rootSessionID,
        stepID: "step_2",
        authorKind: "sub_agent",
        authorTaskID: "task_a",
        kind: "blocker",
        purpose: "candidate_declaration",
        body: "**Blocked** until the fixture is ready.",
        mentions: [],
        attachments: [{ type: "path", value: "src/app.ts" }],
        taskIDs: ["task_a"],
        timeCreated: 2,
        replies: [
          { id: "bb_reply_1", body: "I am checking it now.", timeCreated: 3 },
          { id: "bb_reply_2", body: "Second reply is also visible.", timeCreated: 4 },
        ],
      },
    ],
    unreadCount: 1,
  }
}

function renderPanel(backend: ReturnType<typeof createFakeJyycode>, rootSessionID: string) {
  vi.stubGlobal("fetch", backend.fetch)
  return render(() => (
    <DataProvider
      bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
      generation={0}
      directory={directory}
    >
      <BlackboardPanel
        directory={directory}
        rootSessionID={rootSessionID}
        steps={[{ id: "step_1", title: "Discovery" }, { id: "step_2", title: "Implementation" }]}
        taskLabels={{ task_a: "Investigate", task_b: "Verify" }}
      />
    </DataProvider>
  ))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("BlackboardPanel", () => {
  it("renders sender, kind, task chips, attachments, collapsed replies, and posts a message", async () => {
    const user = userEvent.setup()
    const backend = createFakeJyycode(directory)
    const root = backend.addSession({ id: "ses_root", title: "Root" })
    backend.setBlackboard(root.id, board(root.id))
    renderPanel(backend, root.id)

    expect(await screen.findByText("Blocked")).toBeVisible()
    expect(screen.queryByText(root.id)).not.toBeInTheDocument()
    expect(screen.getByText("子 Agent · Investigate")).toBeVisible()
    expect(screen.getByText("src/app.ts")).toBeVisible()
    expect(screen.getByText("候选声明")).toBeVisible()
    expect(screen.getByText(/展开回复/)).toBeVisible()

    const repliesButton = screen.getByText(/展开回复/)
    await user.click(repliesButton)
    expect(screen.getByText("I am checking it now.")).toBeInTheDocument()
    expect(screen.getByText("Second reply is also visible.")).toBeInTheDocument()
    await waitFor(() => {
      const read = [...backend.requests].reverse().find((request) => request.path === `/session/${root.id}/blackboard/read`)
      expect(read?.body.throughMessageID).toBe("bb_reply_2")
    })
    await user.click(screen.getByRole("button", { name: /回复$/ }))
    expect(screen.getByText(/回复 子 Agent/)).toBeVisible()

    const editor = screen.getByRole("textbox", { name: "发送黑板消息…" })
    await user.type(editor, "Please verify the blocker")
    await user.click(screen.getByRole("button", { name: "发送黑板消息" }))
    await waitFor(() =>
      expect(backend.requests.some((request) => request.path === `/session/${root.id}/blackboard` && request.method === "POST")).toBe(true),
    )
    expect(
      [...backend.requests].reverse().find(
        (request) => request.path === `/session/${root.id}/blackboard` && request.method === "POST",
      )?.body.message,
    ).toBe("Please verify the blocker")
  })

  it("switches to a historical Step and removes the composer", async () => {
    const user = userEvent.setup()
    const backend = createFakeJyycode(directory)
    const root = backend.addSession({ id: "ses_root", title: "Root" })
    backend.setBlackboard(root.id, board(root.id))
    renderPanel(backend, root.id)

    const step = await screen.findByRole("combobox", { name: "当前 Step" })
    await user.selectOptions(step, "step_1")
    expect(await screen.findByText("Old step")).toBeVisible()
    expect(screen.getByText("历史 Step 只读")).toBeVisible()
    expect(screen.queryByRole("textbox", { name: "发送黑板消息…" })).not.toBeInTheDocument()
  })
})
