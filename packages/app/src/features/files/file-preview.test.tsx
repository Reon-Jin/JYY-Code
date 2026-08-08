import type { FileContent, VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DataProvider } from "../../data/context"
import { I18nProvider } from "../../i18n/i18n-context"
import { defaultDesktopSettings } from "../settings/settings-preferences"
import { DesktopBridgeProvider } from "../../platform/context"
import { createFakeDesktop } from "../../test/fake-desktop"
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
    screen.getByRole("button", { name: "返回会话" }).click()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it.each([
    { locale: "zh-CN" as const, back: "返回会话", preview: "预览 Markdown", edit: "编辑 Markdown" },
    { locale: "en-US" as const, back: "Back to session", preview: "Preview Markdown", edit: "Edit Markdown" },
  ])("follows the selected $locale locale for preview controls", async ({ locale, back, preview, edit }) => {
    const backend = createFakeJyycode(directory)
    backend.fileContents.set("README.md", {
      type: "text",
      content: "# Hello",
      revision: "revision-1",
    })
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    const desktop = createFakeDesktop({ settings: { ...defaultDesktopSettings, locale } })

    render(() => (
      <DesktopBridgeProvider bridge={desktop.bridge}>
        <I18nProvider>
          <DataProvider
            bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
            generation={0}
            directory={directory}
          >
            <FilePreview directory={directory} path="README.md" onClose={vi.fn()} />
          </DataProvider>
        </I18nProvider>
      </DesktopBridgeProvider>
    ))

    await screen.findByRole("textbox")
    expect(screen.getByRole("button", { name: back })).toBeVisible()
    await screen.getByRole("button", { name: preview }).click()
    expect(await screen.findByRole("button", { name: edit })).toBeVisible()
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
    await screen.getByRole("button", { name: "预览 Markdown" }).click()
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeVisible()
    expect(screen.queryByText("alert(1)")).not.toBeInTheDocument()
    await screen.getByRole("button", { name: "编辑 Markdown" }).click()
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
    expect(screen.getByText("只读")).toBeVisible()
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
