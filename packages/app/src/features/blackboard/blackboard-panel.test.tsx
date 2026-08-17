import type { SessionBlackboardResponse } from "@jyycode-ai/sdk/v2/client"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal } from "solid-js"
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

function renderPanel(
  backend: ReturnType<typeof createFakeJyycode>,
  rootSessionID: string,
  props?: { postingEnabled?: boolean },
) {
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
        postingEnabled={props?.postingEnabled}
        steps={[
          { id: "step_1", title: "Discovery" },
          { id: "step_2", title: "Implementation" },
        ]}
        taskLabels={{ task_a: "Investigate", task_b: "Verify" }}
      />
    </DataProvider>
  ))
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe("BlackboardPanel", () => {
  it("renders a compact note, expands it on click to show details and replies, and posts a message", async () => {
    const user = userEvent.setup()
    const backend = createFakeJyycode(directory)
    const root = backend.addSession({ id: "ses_root", title: "Root" })
    backend.setBlackboard(root.id, board(root.id))
    renderPanel(backend, root.id)

    expect(await screen.findByText("Blocked")).toBeVisible()
    expect(screen.queryByText(root.id)).not.toBeInTheDocument()
    expect(screen.getByText("子 Agent · Investigate")).toBeVisible()
    expect(screen.getByText("候选声明")).toBeVisible()
    expect(screen.getByText("回复 2")).toBeVisible()
    expect(screen.queryByText("src/app.ts")).not.toBeInTheDocument()
    expect(screen.queryByText("I am checking it now.")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /查看纸条详情/ }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toBeVisible()
    expect(screen.getByText("src/app.ts")).toBeVisible()
    expect(screen.getByText("I am checking it now.")).toBeVisible()
    expect(screen.getByText("Second reply is also visible.")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "关闭" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    await waitFor(() => {
      const read = [...backend.requests]
        .reverse()
        .find((request) => request.path === `/session/${root.id}/blackboard/read`)
      expect(read?.body.throughMessageID).toBe("bb_reply_2")
    })
    const editor = screen.getByRole("textbox", { name: "发送黑板消息…" })
    await user.type(editor, "Please verify the blocker")
    await user.click(screen.getByRole("button", { name: "发送黑板消息" }))
    await waitFor(() =>
      expect(
        backend.requests.some(
          (request) => request.path === `/session/${root.id}/blackboard` && request.method === "POST",
        ),
      ).toBe(true),
    )
    expect(
      [...backend.requests]
        .reverse()
        .find((request) => request.path === `/session/${root.id}/blackboard` && request.method === "POST")?.body
        .message,
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

  it("shows the clicked Step's notes even when the switch lands before the first load settles", async () => {
    const user = userEvent.setup()
    const backend = createFakeJyycode(directory)
    const root = backend.addSession({ id: "ses_root", title: "Root" })
    backend.setBlackboard(root.id, board(root.id))

    // Hold every blackboard list request open so the switch happens while the
    // first snapshot is still in flight, then mirror the real server: a list
    // without a step filter only returns the current Step's notes.
    const original = backend.fetch
    const releases: Array<() => void> = []
    backend.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      const isBlackboardList = url.pathname.endsWith("/blackboard") && request.method === "GET"
      if (!isBlackboardList) return original(input, init)
      return new Promise<Response>((resolve) => {
        releases.push(() => {
          void original(input, init).then(async (response) => {
            if (url.searchParams.has("stepID")) {
              resolve(response)
              return
            }
            const body = (await response.json()) as SessionBlackboardResponse
            body.messages = body.messages.filter((message) => message.stepID === body.currentStepID)
            resolve(new Response(JSON.stringify(body), { status: response.status, headers: response.headers }))
          })
        })
      })
    }) as typeof globalThis.fetch
    renderPanel(backend, root.id)

    const step = await screen.findByRole("combobox", { name: "当前 Step" })
    await user.selectOptions(step, "step_1")
    for (const release of releases) release()

    expect(await screen.findByText("Old step")).toBeVisible()
    expect(screen.queryByText("Blocked")).not.toBeInTheDocument()
    expect(
      backend.requests.some(
        (request) => request.path === `/session/${root.id}/blackboard` && request.query.stepID === "step_1",
      ),
    ).toBe(true)
  })

  it("keeps the selected Step visible in the dropdown when the option list is recreated", async () => {
    const user = userEvent.setup()
    const backend = createFakeJyycode(directory)
    const root = backend.addSession({ id: "ses_root", title: "Root" })
    backend.setBlackboard(root.id, board(root.id))
    const [steps, setSteps] = createSignal([
      { id: "step_1", title: "Discovery" },
      { id: "step_2", title: "Implementation" },
    ])
    vi.stubGlobal("fetch", backend.fetch)
    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
        generation={0}
        directory={directory}
      >
        <BlackboardPanel
          directory={directory}
          rootSessionID={root.id}
          postingEnabled={false}
          steps={steps()}
          taskLabels={{ task_a: "Investigate" }}
        />
      </DataProvider>
    ))

    const step = (await screen.findByRole("combobox", { name: "当前 Step" })) as HTMLSelectElement
    await user.selectOptions(step, "step_1")
    await user.selectOptions(step, "step_2")
    expect(step.value).toBe("step_2")

    // Re-create the Step options with new object identities, as happens when a
    // plan refresh flows into the panel. A native select then resets its
    // displayed value to the first option; the option-level selected binding
    // must restore the user's choice.
    setSteps([
      { id: "step_1", title: "Discovery" },
      { id: "step_2", title: "Implementation" },
    ])
    await waitFor(() => {
      expect(step.options[1]?.selected).toBe(true)
      expect(step.value).toBe("step_2")
      expect(step.options[step.selectedIndex]?.textContent).toBe("Implementation")
    })
  })

  it("keeps notes visible but read-only when posting is disabled in single-agent mode", async () => {
    const backend = createFakeJyycode(directory)
    const root = backend.addSession({ id: "ses_root", title: "Root" })
    backend.setBlackboard(root.id, board(root.id))
    renderPanel(backend, root.id, { postingEnabled: false })

    expect(await screen.findByText("Blocked")).toBeVisible()
    expect(screen.getByText("子 Agent · Investigate")).toBeVisible()
    expect(screen.getByText("单智能体模式下黑板只读，切换到多智能体后可继续发布")).toBeVisible()
    expect(screen.queryByText("多智能体 Session 才支持协作黑板")).not.toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "发送黑板消息…" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "发送黑板消息" })).not.toBeInTheDocument()

    // Notes stay fully interactive for reading.
    fireEvent.click(screen.getByRole("button", { name: /查看纸条详情/ }))
    expect(await screen.findByRole("dialog")).toBeVisible()
  })

  it("drags a note anywhere, raises it above overlapping notes, and persists the layout", async () => {
    const backend = createFakeJyycode(directory)
    const root = backend.addSession({ id: "ses_root", title: "Root" })
    backend.setBlackboard(root.id, board(root.id))
    renderPanel(backend, root.id)

    const note = (await screen.findByText("Blocked")).closest("article")!
    const start = { left: Number.parseFloat(note.style.left), top: Number.parseFloat(note.style.top) }
    expect(Number.isFinite(start.left)).toBe(true)
    expect(Number.isFinite(start.top)).toBe(true)
    const header = note.querySelector(".blackboard-note__header") as HTMLElement

    fireEvent.pointerDown(header, { button: 0, clientX: 120, clientY: 120 })
    fireEvent.pointerMove(window, { clientX: 185, clientY: 205 })
    fireEvent.pointerUp(window, { clientX: 185, clientY: 205 })

    expect(note.style.left).toBe(`${start.left + 65}px`)
    expect(note.style.top).toBe(`${start.top + 85}px`)
    expect(note.style.zIndex).toBe("2")
    expect(note).toHaveAttribute("data-message-id", "bb_current")
    // A drag must not fall through to click-to-expand.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    const stored = JSON.parse(localStorage.getItem(`jyycode.blackboard.layout:${directory}:${root.id}`)!)
    expect(stored.zTop).toBe(2)
    expect(stored.notes.bb_current).toEqual({ x: start.left + 65, y: start.top + 85, z: 2 })

    // A tiny press without movement still counts as a click and expands the note.
    fireEvent.pointerDown(header, { button: 0, clientX: 200, clientY: 200 })
    fireEvent.pointerMove(window, { clientX: 201, clientY: 201 })
    fireEvent.pointerUp(window, { clientX: 201, clientY: 201 })
    fireEvent.click(note)
    expect(await screen.findByRole("dialog")).toBeVisible()
  })

  it("clamps legacy low note positions and does not stretch the board", async () => {
    const backend = createFakeJyycode(directory)
    const root = backend.addSession({ id: "ses_root", title: "Root" })
    backend.setBlackboard(root.id, board(root.id))
    localStorage.setItem(
      `jyycode.blackboard.layout:${directory}:${root.id}`,
      JSON.stringify({ zTop: 1, notes: { bb_current: { x: 20, y: 9999, z: 1 } } }),
    )
    renderPanel(backend, root.id)

    const note = (await screen.findByText("Blocked")).closest("article")!
    expect(Number.parseFloat(note.style.top)).toBeLessThanOrEqual(310)
    const boardElement = note.parentElement!
    expect(boardElement.classList).toContain("blackboard-board")
    expect(boardElement.style.minHeight).toBe("")
  })
})
