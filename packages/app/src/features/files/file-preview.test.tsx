import type { FileContent, VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DataProvider } from "../../data/context"
import { createFakeJyycode } from "../../test/fake-jyycode"
import { contentDataUrl, contentBytes, FilePreview, isFilePreviewEditable, MAX_PREVIEW_BYTES } from "./file-preview"

const directory = "C:\\work\\demo"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function textContent(): FileContent {
  return { type: "text", content: "hello", revision: "revision-1" }
}

describe("FilePreview", () => {
  it("loads scoped text content into the editor and exposes a return action", async () => {
    const backend = createFakeJyycode(directory)
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    const onClose = vi.fn()
    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
        generation={0}
        directory={directory}
      >
        <FilePreview
          directory={directory}
          workspaceID="wrk_child"
          sessionID="ses_child"
          path="src/app.tsx"
          onClose={onClose}
        />
      </DataProvider>
    ))

    expect(await screen.findByRole("textbox")).toHaveTextContent("export const app = true")
    expect(backend.requests.find((request) => request.path === "/file/content")?.query).toMatchObject({
      directory,
      workspace: "wrk_child",
      path: "src/app.tsx",
    })
    screen.getByRole("button", { name: "Back to session" }).click()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("switches Markdown between editor and sanitized preview", async () => {
    const backend = createFakeJyycode(directory)
    backend.fileContents.set("README.md", {
      type: "text",
      content: "# Hello\n\n<script>alert(1)</script>",
      revision: "revision-1",
    })
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    backend.fileNodes[""]?.push({
      name: "README.md",
      path: "README.md",
      absolute: `${directory}\\README.md`,
      type: "file",
      ignored: false,
    })
    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
        generation={0}
        directory={directory}
      >
        <FilePreview directory={directory} path="README.md" />
      </DataProvider>
    ))

    await screen.findByRole("textbox")
    await screen.getByRole("button", { name: "Preview Markdown" }).click()
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeVisible()
    expect(screen.queryByText("alert(1)")).not.toBeInTheDocument()
    await screen.getByRole("button", { name: "Edit Markdown" }).click()
    await waitFor(() => expect(screen.getByRole("textbox")).toBeVisible())
  })

  it("previews deleted text from the diff patch as read-only content", async () => {
    const backend = createFakeJyycode(directory)
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    const change: VcsFileDiff = {
      file: "src/deleted.ts",
      status: "deleted",
      additions: 0,
      deletions: 2,
      patch: "@@ -1,2 +0,0 @@\n-old value\n-old second value",
    }

    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
        generation={0}
        directory={directory}
      >
        <FilePreview directory={directory} path={change.file} change={change} />
      </DataProvider>
    ))

    const editor = await screen.findByRole("textbox")
    expect(editor).toHaveTextContent("old value")
    expect(screen.getByText("Read-only")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Save file" })).not.toBeInTheDocument()
  })
})

describe("file preview helpers", () => {
  it("builds binary data URLs and editability decisions", () => {
    const image: FileContent = {
      type: "text",
      content: "aGVsbG8=",
      encoding: "base64",
      mimeType: "image/png",
      revision: "1",
    }
    expect(contentBytes(image)).toEqual(new Uint8Array([104, 101, 108, 108, 111]))
    expect(contentDataUrl(image)).toBe("data:image/png;base64,aGVsbG8=")
    expect(MAX_PREVIEW_BYTES).toBe(25 * 1024 * 1024)
    expect(isFilePreviewEditable("src/app.tsx", textContent())).toBe(true)
    expect(isFilePreviewEditable("image.png", image)).toBe(false)
  })
})
