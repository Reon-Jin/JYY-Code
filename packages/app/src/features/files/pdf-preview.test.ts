import type { JyycodeClient } from "@jyycode-ai/sdk/v2/client"
import { describe, expect, it, vi } from "vitest"
import { PDFDocument } from "pdf-lib"
import { PDF_TRANSLATION_MAX_CHARS, flattenPdfAnnotations, pdfPageRows, pdfTranslationTarget, translatePdfText } from "./pdf-preview"

describe("PDF preview helpers", () => {
  it("targets Chinese selections to English and other selections to Chinese", () => {
    expect(pdfTranslationTarget("\u4e2d\u6587\u6587\u672c")).toBe("en")
    expect(pdfTranslationTarget("English text")).toBe("zh-CN")
    expect(pdfTranslationTarget("Esto es espa\u00f1ol")).toBe("zh-CN")
    expect(pdfTranslationTarget("\u3053\u308c\u306f\u65e5\u672c\u8a9e\u3067\u3059")).toBe("zh-CN")
  })

  it("groups pages into rows for the selected layout", () => {
    expect(pdfPageRows(3, "single")).toEqual([[1], [2], [3]])
    expect(pdfPageRows(5, "spread")).toEqual([[1, 2], [3, 4], [5]])
  })

  it("translates with the active configured model and cleans up the transient session", async () => {
    const session = {
      get: vi.fn().mockResolvedValue({
        data: { id: "ses_parent", agent: "build", model: { id: "deepseek-v4-flash", providerID: "deepseek" } },
      }),
      create: vi.fn().mockResolvedValue({ data: { id: "ses_translation" } }),
      prompt: vi.fn().mockResolvedValue({ data: { parts: [{ type: "text", text: "translated text" }] } }),
      abort: vi.fn().mockResolvedValue({ data: true }),
      delete: vi.fn().mockResolvedValue({ data: true }),
    }
    const source = "a".repeat(PDF_TRANSLATION_MAX_CHARS + 1)
    const client = { session } as unknown as Pick<JyycodeClient, "session">

    expect(await translatePdfText({ client, directory: "D:/repo", sessionID: "ses_parent", text: source })).toBe(
      "translated text",
    )
    expect(session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parentID: "ses_parent",
        agent: "build",
        model: { id: "deepseek-v4-flash", providerID: "deepseek" },
        permission: [{ permission: "*", pattern: "*", action: "deny" }],
      }),
      { throwOnError: true },
    )
    expect(session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "ses_translation",
        model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
        tools: {},
        parts: [{ type: "text", text: "a".repeat(PDF_TRANSLATION_MAX_CHARS) }],
      }),
      { throwOnError: true },
    )
    expect(session.delete).toHaveBeenCalledWith(
      { directory: "D:/repo", sessionID: "ses_translation" },
      { throwOnError: true },
    )
  })

  it("deletes the transient translation session after a model failure", async () => {
    const failure = new Error("model unavailable")
    const session = {
      get: vi.fn().mockResolvedValue({ data: { id: "ses_parent" } }),
      create: vi.fn().mockResolvedValue({ data: { id: "ses_translation" } }),
      prompt: vi.fn().mockRejectedValue(failure),
      abort: vi.fn().mockResolvedValue({ data: true }),
      delete: vi.fn().mockResolvedValue({ data: true }),
    }
    const client = { session } as unknown as Pick<JyycodeClient, "session">

    await expect(translatePdfText({ client, directory: "D:/repo", sessionID: "ses_parent", text: "source" })).rejects.toBe(
      failure,
    )
    expect(session.delete).toHaveBeenCalledOnce()
  })

  it("flattens pen and shape annotations into a valid PDF", async () => {
    const document = await PDFDocument.create()
    document.addPage([240, 320])
    const result = await flattenPdfAnnotations(await document.save(), [
      {
        id: "pen-1",
        page: 1,
        tool: "pen",
        color: "#e5484d",
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.4 },
        ],
        strokeWidth: 0.009,
      },
      {
        id: "rectangle-1",
        page: 1,
        tool: "rectangle",
        color: "#2563eb",
        x: 0.2,
        y: 0.2,
        width: 0.2,
        height: 0.15,
        strokeWidth: 0.006,
      },
      { id: "line-1", page: 1, tool: "line", color: "#16a34a", x: 0.1, y: 0.7, width: 0.3, height: -0.12, strokeWidth: 0.004 },
    ])

    expect((await PDFDocument.load(result)).getPageCount()).toBe(1)
  })
})
