import { describe, expect, test } from "bun:test"
import { htmlPreviewHostDocument, parseFileByteRange } from "../../src/server/routes/instance/httpapi/handlers/file-media"

describe("file media byte ranges", () => {
  test("limits open-ended and suffix ranges to the streaming chunk size", () => {
    expect(parseFileByteRange("bytes=0-", 10_000_000, 4_096)).toEqual({ start: 0, end: 4_095 })
    expect(parseFileByteRange("bytes=-100", 10_000_000, 4_096)).toEqual({ start: 9_999_900, end: 9_999_999 })
    expect(parseFileByteRange("bytes=500-900", 10_000_000, 4_096)).toEqual({ start: 500, end: 900 })
  })

  test("rejects invalid or unsatisfiable ranges", () => {
    expect(parseFileByteRange("items=0-10", 100)).toBeUndefined()
    expect(parseFileByteRange("bytes=100-101", 100)).toBeUndefined()
    expect(parseFileByteRange("bytes=5-2", 100)).toBeUndefined()
  })
})

describe("HTML preview host", () => {
  test("renders drafts inside a second sandbox and forwards zoom events", () => {
    const html = htmlPreviewHostDocument()

    expect(html).toContain('sandbox="allow-scripts allow-forms allow-modals"')
    expect(html).toContain('data?.type === "jyycode-html-preview-render"')
    expect(html).toContain("preview.srcdoc = data.html")
    expect(html).toContain('data?.type === "jyycode-html-preview-zoom"')
    expect(html).toContain('type: "jyycode-html-preview-ready"')
  })
})
