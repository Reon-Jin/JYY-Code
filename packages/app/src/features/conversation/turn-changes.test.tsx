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
  it("anchors images and file changes after the final reply to a hidden background completion", () => {
    const changes: SnapshotFileDiff[] = [
      { file: "render.py", additions: 10, deletions: 0, status: "added" },
      { file: "result.png", additions: 0, deletions: 0, status: "added" },
    ]
    const wake = { ...user, id: "msg_wake", time: { created: 4 }, summary: { diffs: [changes[1]!] } }
    const reply = { ...assistant, id: "msg_final", parentID: wake.id, time: { created: 5, completed: 6 } }
    const messages = [
      message({ ...user, summary: { diffs: [changes[0]!] } }, "draw a picture"),
      message(assistant, "rendering"),
      {
        info: wake,
        parts: [
          {
            id: "prt_wake",
            sessionID: wake.sessionID,
            messageID: wake.id,
            type: "text" as const,
            synthetic: true,
            text: "Background shell command finished",
          },
        ],
      },
      message(reply, "delivered"),
    ]
    const summaries = turnChangeSummaries(messages, presentConversationMessages(messages), false)
    expect([...summaries.values()]).toHaveLength(1)
    expect([...summaries.values()][0]?.changes).toEqual(changes)
    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "test", password: "test" }}
        directory="C:\\work"
        generation={0}
      >
        <MessageTimeline messages={messages} running={false} />
      </DataProvider>
    ))
    const image = screen.getByRole("img", { name: "result.png" })
    expect(image).toHaveAttribute("src", expect.stringContaining("result.png"))
    expect(screen.getByText("delivered").compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText("Background shell command finished")).not.toBeInTheDocument()
  })

  it("keeps completed file rows, patches, media and focus mounted while the next turn streams", () => {
    const changes = [...diffs.slice(0, 2), { file: "simple.png", additions: 0, deletions: 0, status: "added" as const }]
    const nextUser = { ...user, id: "msg_next_user", time: { created: 4 }, summary: undefined }
    const nextAssistant = { ...assistant, id: "msg_next_reply", parentID: nextUser.id, time: { created: 5 } }
    const [messages, setMessages] = createSignal<ConversationMessage[]>([
      message({ ...user, summary: { diffs: changes } }, "first"),
      message(assistant, "done"),
      message(nextUser, "next"),
      message(nextAssistant, "stream"),
    ])
    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "test", password: "secret" }}
        directory="C:\\work"
        generation={0}
      >
        <MessageTimeline messages={messages()} running />
      </DataProvider>
    ))
    const card = screen.getByRole("region", { name: "本轮文件变更" })
    const row = within(card).getByRole("button", { name: "src/file-0.ts, +1 -0" })
    fireEvent.click(row)
    const patch = within(card).getByLabelText("src/file-0.ts Diff")
    const patchLine = within(patch).getByText("new value")
    const image = within(card).getByRole("img")
    const header = within(card).getByText("已更改 3 个文件")
    row.focus()
    for (let i = 0; i < 20; i++) {
      setMessages([
        message({ ...user, summary: { diffs: changes.map((change) => ({ ...change })) } }, "first"),
        message({ ...assistant }, "done"),
        message({ ...nextUser }, "next"),
        message({ ...nextAssistant }, "stream".repeat(i + 2)),
      ])
      expect(screen.getByRole("region", { name: "本轮文件变更" })).toBe(card)
      expect(within(card).getByRole("button", { name: "src/file-0.ts, +1 -0" })).toBe(row)
      expect(within(card).getByText("已更改 3 个文件")).toBe(header)
      expect(within(patch).getByText("new value")).toBe(patchLine)
      expect(within(card).getByRole("img")).toBe(image)
      expect(document.activeElement).toBe(row)
      expect(row).toHaveAttribute("aria-expanded", "true")
    }
    fireEvent.click(within(card).getByRole("button", { name: "查看图片 simple.png" }))
    const dialog = screen.getByRole("dialog", { name: "simple.png" })
    for (let i = 0; i < 10; i++) {
      setMessages([
        message({ ...user, summary: { diffs: changes.map((change) => ({ ...change })) } }, "first"),
        message({ ...assistant }, "done"),
        message({ ...nextUser }, "next"),
        message({ ...nextAssistant }, `more stream ${i}`),
      ])
      expect(screen.getByRole("dialog", { name: "simple.png" })).toBe(dialog)
    }
  })
  it("omits the whole card when no files changed, including internal-only diffs", () => {
    const { container, unmount } = render(() => <TurnChanges summary={{ messageID: user.id, changes: [] }} />)
    expect(container.querySelector(".turn-changes")).toBeNull()
    expect(screen.queryByText("本轮未更改文件")).not.toBeInTheDocument()
    unmount()
    for (const changes of [
      [],
      [{ file: ".jyycode/state.json", additions: 1, deletions: 0, status: "modified" as const }],
    ]) {
      const messages = [
        message({ ...user, summary: { diffs: changes } }, "write an essay"),
        message(assistant, "essay"),
      ]
      expect(turnChangeSummaries(messages, presentConversationMessages(messages), false).size).toBe(0)
      const view = render(() => <MessageTimeline messages={messages} running={false} />)
      expect(view.container.querySelector(".turn-changes")).toBeNull()
      view.unmount()
    }
  })
  it("prioritizes video, then images, then the file list in a completed mixed-output turn", () => {
    const mixedDiffs: SnapshotFileDiff[] = [
      ...diffs.slice(0, 6),
      ...Array.from({ length: 6 }, (_, i) => ({
        file: `output/result-${i}.PNG`,
        additions: 0,
        deletions: 0,
        status: "added" as const,
      })),
      { file: "output/sound.wav", additions: 0, deletions: 0, status: "added" },
      { file: "output/clip.mp4", additions: 0, deletions: 0, status: "added" },
    ]
    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "test", password: "secret" }}
        directory="C:\\work"
        generation={0}
      >
        <MessageTimeline
          messages={[
            message({ ...user, summary: { diffs: mixedDiffs } }, "generate outputs"),
            message(assistant, "done"),
          ]}
          running={false}
        />
      </DataProvider>
    ))
    const card = screen.getByRole("region", { name: "本轮文件变更" })
    const images = screen.getAllByRole("img")
    const files = within(card).getByRole("list")
    const video = card.querySelector("video")!
    expect(video).toHaveAttribute("controls")
    expect(video.compareDocumentPosition(images[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(video.compareDocumentPosition(card.querySelector("audio")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(images).toHaveLength(4)
    expect(images[0]!.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(card).getAllByRole("listitem")).toHaveLength(5)
    fireEvent.click(screen.getByRole("button", { name: "再显示 9 个文件" }))
    expect(within(card).getAllByRole("listitem")).toHaveLength(14)
    expect(screen.getAllByRole("img")).toHaveLength(4)
    fireEvent.click(screen.getByRole("button", { name: "再显示 2 张图片" }))
    expect(screen.getAllByRole("img")).toHaveLength(6)
    fireEvent.click(screen.getByRole("button", { name: "收起图片" }))
    expect(screen.getAllByRole("img")).toHaveLength(4)
  })
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
  it("shares the four-image budget across assistant groups and hidden wakeups in the same user turn", () => {
    const wake = { ...user, id: "msg_image_wake", summary: undefined }
    const replies = [0, 1].map((group) => {
      const info = {
        ...assistant,
        id: `msg_images${group}`,
        agent: group ? "review" : "build",
        parentID: group ? wake.id : user.id,
      }
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
      <MessageTimeline
        messages={[
          message({ ...user, summary: undefined }, "images"),
          replies[0]!,
          {
            info: wake,
            parts: [
              {
                id: "prt_image_wake",
                sessionID: wake.sessionID,
                messageID: wake.id,
                type: "text",
                text: "Background completed",
                synthetic: true,
              },
            ],
          },
          replies[1]!,
        ]}
        running={false}
      />
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
