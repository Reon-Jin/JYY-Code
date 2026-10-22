import type { AssistantMessage, SnapshotFileDiff, UserMessage } from "@jyycode-ai/sdk/v2/client"
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { DataProvider } from "../../data/context"
import { TurnChanges, turnChangeSummaries } from "./turn-changes"
import { MessageTimeline } from "./message-timeline"
import type { ConversationMessage } from "./conversation-state"
import { presentConversationMessages } from "./message-presentation"

afterEach(cleanup)
const diffs: SnapshotFileDiff[] = Array.from({ length: 8 }, (_, i) => ({
  file: `src/file-${i}.ts`,
  additions: i + 1,
  deletions: i,
  status: "modified",
  patch: "@@ -1 +1 @@\n-old value\n+new value",
}))
const user: UserMessage = {
  id: "msg_user",
  role: "user",
  sessionID: "ses_root",
  agent: "build",
  model: { providerID: "test", modelID: "test" },
  time: { created: 1 },
  summary: { diffs },
}
const assistant: AssistantMessage = {
  id: "msg_reply",
  role: "assistant",
  sessionID: user.sessionID,
  parentID: user.id,
  agent: "build",
  mode: "build",
  modelID: "test",
  providerID: "test",
  path: { cwd: "C:\\work", root: "C:\\work" },
  time: { created: 2, completed: 3 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  finish: "stop",
}
const message = (info: UserMessage | AssistantMessage, text: string): ConversationMessage => ({
  info,
  parts: [{ id: `prt_${info.id}`, sessionID: info.sessionID, messageID: info.id, type: "text", text }],
})

describe("turn changes", () => {
  it("lists five files, folds the remainder and lets a file expose its own patch", () => {
    render(() => <TurnChanges summary={{ messageID: user.id, changes: diffs }} />)
    const card = screen.getByRole("region", { name: "本轮文件变更" })
    expect(within(card).getByText("已更改 8 个文件")).toBeVisible()
    expect(within(card).getAllByRole("listitem")).toHaveLength(5)
    expect(within(card).queryByText("src/file-5.ts")).not.toBeInTheDocument()
    fireEvent.click(within(card).getByRole("button", { name: "再显示 3 个文件" }))
    expect(within(card).getAllByRole("listitem")).toHaveLength(8)
    fireEvent.click(within(card).getByRole("button", { name: "src/file-0.ts, +1 -0" }))
    expect(within(card).getByText("new value")).toBeVisible()
    fireEvent.click(within(card).getByRole("button", { name: "收起文件" }))
    expect(within(card).getAllByRole("listitem")).toHaveLength(5)
  })
  it("mounts only four new image previews and native audio/video controls until explicitly expanded", () => {
    const changes: SnapshotFileDiff[] = [
      ...Array.from({ length: 7 }, (_, i) => ({
        file: `images/${i}.png`,
        additions: 0,
        deletions: 0,
        status: "added" as const,
      })),
      { file: "sound.wav", additions: 0, deletions: 0, status: "added" },
      { file: "clip.mp4", additions: 0, deletions: 0, status: "added" },
      { file: "deleted.png", additions: 0, deletions: 0, status: "deleted" },
    ]
    const { container } = render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "test", password: "secret" }}
        directory="C:\\work"
        generation={0}
      >
        <TurnChanges summary={{ messageID: user.id, directory: "C:\\work", changes }} />
      </DataProvider>
    ))
    expect(screen.getAllByRole("img")).toHaveLength(4)
    expect(screen.queryByRole("img", { name: "deleted.png" })).not.toBeInTheDocument()
    const image = screen.getAllByRole("img")[0]!
    expect(new URL(image.getAttribute("src")!).searchParams.get("auth_token")).toBe(btoa("test:secret"))
    expect(new URL(image.getAttribute("src")!).searchParams.get("version")).toBe(user.id)
    expect(container.querySelector("audio")).toHaveAttribute("controls")
    expect(container.querySelector("audio")).toHaveAttribute("preload", "none")
    expect(container.querySelector("video")).toHaveAttribute("controls")
    expect(container.querySelector("video")).not.toHaveAttribute("autoplay")
    fireEvent.click(screen.getByRole("button", { name: "再显示 3 张图片" }))
    expect(screen.getAllByRole("img")).toHaveLength(7)
    fireEvent.click(screen.getByRole("button", { name: "收起图片" }))
    expect(screen.getAllByRole("img")).toHaveLength(4)
  })
  it("isolates rounds, merges tool steps into a single end card and keeps old cards while the next turn runs", () => {
    const first = message(assistant, "done")
    const nextUser = {
      ...user,
      id: "msg_user2",
      time: { created: 4 },
      summary: { diffs: [{ file: "second.ts", additions: 9, deletions: 0, status: "added" as const }] },
    }
    const nextAssistant = { ...assistant, id: "msg_reply2", parentID: nextUser.id, time: { created: 5, completed: 6 } }
    const messages = [message(user, "first"), first, message(nextUser, "second"), message(nextAssistant, "done second")]
    const summaries = turnChangeSummaries(messages, presentConversationMessages(messages), true)
    expect(summaries.size).toBe(1)
    expect(summaries.get(assistant.id)?.changes).toEqual(diffs)
    const complete = turnChangeSummaries(messages, presentConversationMessages(messages), false)
    expect(complete.get(nextAssistant.id)?.changes[0]?.file).toBe("second.ts")
    const tool = { ...assistant, id: "msg_tool", finish: "tool-calls" }
    const multi = [message(user, "first"), message(tool, "working"), first]
    expect(turnChangeSummaries(multi, presentConversationMessages(multi), false).size).toBe(1)
  })
  it("adds a late-arriving persisted summary only after the active turn completes", () => {
    const [running, setRunning] = createSignal(true)
    const [messages, setMessages] = createSignal([
      message({ ...user, summary: undefined }, "first"),
      message(assistant, "done"),
    ])
    render(() => <MessageTimeline messages={messages()} running={running()} />)
    setMessages([message(user, "first"), message(assistant, "done")])
    expect(screen.queryByRole("region", { name: "本轮文件变更" })).not.toBeInTheDocument()
    setRunning(false)
    expect(screen.getAllByRole("region", { name: "本轮文件变更" })).toHaveLength(1)
  })
  it("shares the four-image budget across different assistant groups in the same user turn", () => {
    const replies = [0, 1].map((group) => {
      const info = { ...assistant, id: `msg_images${group}`, agent: group ? "review" : "build" }
      return {
        info,
        parts: Array.from({ length: 3 }, (_, index) => ({
          id: `prt_image${group}_${index}`,
          sessionID: info.sessionID,
          messageID: info.id,
          type: "file" as const,
          mime: "image/png",
          filename: `image${group}_${index}.png`,
          url: "data:image/png;base64,aGVsbG8=",
        })),
      }
    })
    render(() => (
      <MessageTimeline messages={[message({ ...user, summary: undefined }, "images"), ...replies]} running={false} />
    ))
    expect(screen.getAllByRole("img")).toHaveLength(4)
    fireEvent.click(screen.getByRole("button", { name: "再显示 2 张图片" }))
    expect(screen.getAllByRole("img")).toHaveLength(6)
    fireEvent.click(screen.getByRole("button", { name: "收起图片" }))
    expect(screen.getAllByRole("img")).toHaveLength(4)
  })
  it("resolves snapshot media against the worktree root and keeps non-git sessions in their cwd", () => {
    for (const [root, expected] of [
      ["C:\\repo", "C:\\repo"],
      ["/", "C:\\repo\\subdir"],
    ]) {
      const messages = [
        message(user, "update"),
        message({ ...assistant, path: { cwd: "C:\\repo\\subdir", root: root! } }, "done"),
      ]
      const summaries = turnChangeSummaries(messages, presentConversationMessages(messages), false)
      expect(summaries.get(assistant.id)?.directory).toBe(expected)
    }
  })
})
