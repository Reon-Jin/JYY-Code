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

  it("translates selections up to 5,000 characters in API-safe chunks", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input.toString())
      return new Response(JSON.stringify([[[url.searchParams.get("q")]]]))
    })
    const source = "a".repeat(PDF_TRANSLATION_MAX_CHARS + 1)

    expect((await translatePdfText(source)).replaceAll(" ", "")).toBe("a".repeat(PDF_TRANSLATION_MAX_CHARS))
    expect(fetchMock).toHaveBeenCalledTimes(Math.ceil(PDF_TRANSLATION_MAX_CHARS / 450))
    for (const [input] of fetchMock.mock.calls) {
      expect(new URL(input.toString()).searchParams.get("q")?.length).toBeLessThanOrEqual(450)
      expect(new URL(input.toString()).searchParams.get("tl")).toBe("zh-CN")
    }
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
