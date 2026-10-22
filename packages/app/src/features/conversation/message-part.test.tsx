import type { FilePart, PatchPart, StepFinishPart, StepStartPart } from "@jyycode-ai/sdk/v2/client"
import { createSignal } from "solid-js"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { MessagePartView } from "./message-part"
import { DataProvider } from "../../data/context"

const base = { id: "part_step", sessionID: "ses_1", messageID: "msg_1" }

afterEach(cleanup)

describe("MessagePartView", () => {
  it("keeps an image preview open across attachment refreshes until the user closes it", () => {
    const [part, setPart] = createSignal<FilePart>({
      ...base,
      type: "file",
      mime: "image/png",
      filename: "artwork.png",
      url: "data:image/png;base64,aGVsbG8=",
    })
    render(() => <MessagePartView part={part()} />)
    fireEvent.click(screen.getByRole("button", { name: "查看图片 artwork.png" }))
    const dialog = screen.getByRole("dialog", { name: "artwork.png" })
    for (let i = 0; i < 20; i++) {
      setPart({ ...part() })
      expect(screen.getByRole("dialog", { name: "artwork.png" })).toBe(dialog)
    }
    setPart({ ...part(), url: "data:image/png;base64,bmV3=" })
    expect(screen.getByRole("dialog", { name: "artwork.png" })).toBe(dialog)
    fireEvent.click(dialog.querySelector("button")!)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
  it("shows a compact skill badge and the user's request while hiding the expanded instructions", () => {
    render(() => (
      <MessagePartView
        messageRole="user"
        part={{
          ...base,
          type: "text",
          text: "# Long skill instructions\nHidden output contract",
          metadata: { skill: { name: "jyy-drawing", arguments: "画一幅苏州园林的水彩画" } },
        }}
      />
    ))
    expect(screen.getByLabelText("Skill: jyy-drawing")).toBeVisible()
    expect(screen.getByText("画一幅苏州园林的水彩画")).toBeVisible()
    expect(screen.queryByText(/Hidden output contract|Long skill instructions/)).not.toBeInTheDocument()
  })
  it("keeps a skill invocation visible when the user supplies no extra arguments", () => {
    render(() => (
      <MessagePartView
        messageRole="user"
        part={{
          ...base,
          type: "text",
          text: "# Hidden skill body",
          metadata: { skill: { name: "review", arguments: "" } },
        }}
      />
    ))
    expect(screen.getByLabelText("Skill: review")).toBeVisible()
    expect(screen.queryByText(/Hidden skill body/)).not.toBeInTheDocument()
  })
  it.each(["audio/wav", "video/mp4"])("renders persisted %s attachments with authenticated native controls", (mime) => {
    const { container } = render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "test", password: "secret" }}
        directory="C:\\work"
        generation={0}
      >
        <MessagePartView
          part={{ ...base, type: "file", mime, filename: "output", url: `blob:sha256:${"b".repeat(64)}` }}
        />
      </DataProvider>
    ))
    const media = container.querySelector(mime.startsWith("audio/") ? "audio" : "video")!
    expect(media).toHaveAttribute("controls")
    expect(media).not.toHaveAttribute("autoplay")
    expect(new URL(media.getAttribute("src")!).pathname).toBe("/session/ses_1/message/msg_1/part/part_step/attachment")
    expect(new URL(media.getAttribute("src")!).searchParams.get("auth_token")).toBe(btoa("test:secret"))
  })
  it("loads persisted image references through an authenticated attachment URL and expands them", () => {
    const filename = "pasted.png"
    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
        directory="C:\\work\\demo"
        generation={0}
      >
        <MessagePartView
          part={{ ...base, type: "file", mime: "image/png", filename, url: `blob:sha256:${"a".repeat(64)}` }}
        />
      </DataProvider>
    ))
    const image = screen.getByRole("img", { name: filename })
    const url = new URL(image.getAttribute("src")!)
    expect(url.pathname).toBe("/session/ses_1/message/msg_1/part/part_step/attachment")
    expect(url.searchParams.get("auth_token")).toBe(btoa("jyycode:secret"))
    fireEvent.click(screen.getByRole("button", { name: "查看图片 pasted.png" }))
    expect(screen.getByRole("dialog", { name: filename })).toBeInTheDocument()
  })

  it("shows pasted inline image data directly and reports loading failures without a broken filename image", () => {
    const url = "data:image/png;base64,aGVsbG8="
    render(() => <MessagePartView part={{ ...base, type: "file", mime: "image/png", filename: "inline.png", url }} />)
    const image = screen.getByRole("img", { name: "inline.png" })
    expect(image).toHaveAttribute("src", url)
    fireEvent.error(image)
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("图片暂时无法加载")
  })

  it("does not expose structural step markers as unsupported content", () => {
    const start: StepStartPart = { ...base, type: "step-start" }
    const finish: StepFinishPart = {
      ...base,
      id: "part_finish",
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    render(() => (
      <>
        <MessagePartView part={start} />
        <MessagePartView part={finish} />
      </>
    ))

    expect(screen.queryByText(/Unsupported content/)).not.toBeInTheDocument()
  })

  it("does not expose snapshot patch metadata as unsupported content", () => {
    const patch: PatchPart = {
      ...base,
      id: "part_patch",
      type: "patch",
      hash: "abc123",
      files: ["D:/jyycode/.jyycode/plan/ses_1/plan.json"],
    }
    render(() => <MessagePartView part={patch} />)

    expect(screen.queryByText(/Unsupported content/)).not.toBeInTheDocument()
    expect(screen.queryByText(/plan\.json/)).not.toBeInTheDocument()
  })
})
