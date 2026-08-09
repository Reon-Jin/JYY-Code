import type { FileContent, VcsFileDiff } from "@jyycode-ai/sdk/v2/client"
import * as XLSX from "xlsx"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DataProvider } from "../../data/context"
import { I18nProvider } from "../../i18n/i18n-context"
import { defaultDesktopSettings } from "../settings/settings-preferences"
import { DesktopBridgeProvider } from "../../platform/context"
import { createFakeDesktop } from "../../test/fake-desktop"
import { createFakeJyycode } from "../../test/fake-jyycode"
import {
  contentDataUrl,
  contentBytes,
  contentText,
  FilePreview,
  isFilePreviewEditable,
  MAX_PREVIEW_BYTES,
  nextPreviewZoom,
  pdfCanvasMetrics,
  PREVIEW_ZOOM_MAX,
  PREVIEW_ZOOM_MIN,
} from "./file-preview"

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

  it("renders browser-like HTML files as a preview", async () => {
    const backend = createFakeJyycode(directory)
    backend.fileContents.set("index.html", {
      type: "text",
      content: '<h1>Hello</h1><script>alert("unsafe")</script>',
      revision: "revision-1",
    })
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
        generation={0}
        directory={directory}
      >
        <FilePreview directory={directory} path="index.html" />
      </DataProvider>
    ))

    await screen.findByRole("textbox")
    await screen.getByRole("button", { name: "预览 HTML" }).click()
    const frame = await screen.findByTitle("index.html")
    expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-modals")
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Hello</h1>")
    expect(frame.getAttribute("srcdoc")).toContain('<script>alert("unsafe")</script>')
    expect(frame.getAttribute("srcdoc")).toContain("<base href=")
    expect(frame.getAttribute("srcdoc")).toContain("jyycode-html-preview-zoom")
  })

  it("switches HTML between editor and sanitized preview using the draft", async () => {
    const user = userEvent.setup()
    const backend = createFakeJyycode(directory)
    backend.fileContents.set("index.html", {
      type: "text",
      content: '<h1>Hello</h1><script>alert("unsafe")</script>',
      revision: "revision-1",
    })
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
        generation={0}
        directory={directory}
      >
        <FilePreview directory={directory} path="index.html" />
      </DataProvider>
    ))

    const editor = await screen.findByRole("textbox")
    editor.focus()
    await user.keyboard("{Control>}a{/Control}")
    await user.keyboard('<h1>Draft</h1><script>alert("unsafe")</script>')
    await screen.getByRole("button", { name: "预览 HTML" }).click()

    const frame = await screen.findByTitle("index.html")
    expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-modals")
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Draft</h1>")
    expect(frame.getAttribute("srcdoc")).toContain('<script>alert("unsafe")</script>')
    expect(frame.getAttribute("srcdoc")).toContain("<base href=")
    expect(frame.getAttribute("srcdoc")).toContain("jyycode-html-preview-zoom")
    await screen.getByRole("button", { name: "编辑 HTML" }).click()
    await waitFor(() => expect(screen.getByRole("textbox")).toBeVisible())
  })

  it("opens and saves CSV files through the spreadsheet grid", async () => {
    const user = userEvent.setup()
    const backend = createFakeJyycode(directory)
    backend.fileContents.set("data.csv", {
      type: "text",
      content: "Name,Amount\nAlice,1",
      revision: "revision-csv",
    })
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
        generation={0}
        directory={directory}
      >
        <FilePreview directory={directory} workspaceID="wrk_child" sessionID="ses_child" path="data.csv" />
      </DataProvider>
    ))

    const amount = await screen.findByRole("textbox", { name: "B2" })
    await user.click(amount)
    await user.keyboard("{Control>}a{/Control}2")
    await user.click(screen.getByRole("button", { name: "保存文件" }))
    await waitFor(() => expect(backend.fileContents.get("data.csv")?.content).toContain("Alice,2"))
    expect(
      backend.requests.find((request) => request.method === "PUT" && request.path === "/file/content")?.body,
    ).toMatchObject({
      path: "data.csv",
      revision: "revision-csv",
    })
  })

  it("opens base64 Excel workbooks with their sheet tabs", async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Summary"], ["Ready"]]), "Summary")
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Details"], ["One"]]), "Details")
    const backend = createFakeJyycode(directory)
    backend.fileContents.set("report.xlsx", {
      type: "text",
      content: XLSX.write(workbook, { type: "base64", bookType: "xlsx" }) as string,
      encoding: "base64",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      revision: "revision-xlsx",
    })
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
        generation={0}
        directory={directory}
      >
        <FilePreview directory={directory} path="report.xlsx" />
      </DataProvider>
    ))

    expect(await screen.findByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: "Details" })).toBeVisible()
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
    expect(contentText({ type: "text", content: "<h1>Hello</h1>", revision: "1" })).toBe("<h1>Hello</h1>")
    expect(MAX_PREVIEW_BYTES).toBe(25 * 1024 * 1024)
    expect(isFilePreviewEditable("src/app.tsx", textContent())).toBe(true)
    expect(isFilePreviewEditable("report.xlsx", { ...image, type: "text", mimeType: "application/vnd.ms-excel" })).toBe(
      true,
    )
    expect(isFilePreviewEditable("image.png", image)).toBe(false)
  })

  it("keeps the logical PDF size while scaling its backing store for HiDPI displays", () => {
    expect(pdfCanvasMetrics({ width: 816, height: 1056 }, 2)).toEqual({
      width: 1632,
      height: 2112,
      cssWidth: 816,
      cssHeight: 1056,
      outputScale: 2,
    })
  })

  it("clamps Ctrl-wheel preview zoom to a usable range", () => {
    expect(nextPreviewZoom(1, -1)).toBeCloseTo(1.1)
    expect(nextPreviewZoom(PREVIEW_ZOOM_MAX, -1)).toBe(PREVIEW_ZOOM_MAX)
    expect(nextPreviewZoom(PREVIEW_ZOOM_MIN, 1)).toBe(PREVIEW_ZOOM_MIN)
  })
})
