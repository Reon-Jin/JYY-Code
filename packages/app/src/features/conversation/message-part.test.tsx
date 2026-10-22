import type { PatchPart, StepFinishPart, StepStartPart } from "@jyycode-ai/sdk/v2/client"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { MessagePartView } from "./message-part"
import { DataProvider } from "../../data/context"

const base = { id: "part_step", sessionID: "ses_1", messageID: "msg_1" }

afterEach(cleanup)

describe("MessagePartView", () => {
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
