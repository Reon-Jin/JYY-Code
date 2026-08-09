import { describe, expect, it } from "vitest"
import { isDeletedChange, isEditableText, isHiddenFileNode, previewKind } from "./file-types"

describe("file preview types", () => {
  it.each([
    ["src/app.ts", "code"],
    ["src/data.json", "code"],
    ["docs/readme.md", "markdown"],
    ["notes.txt", "text"],
    ["data.csv", "spreadsheet"],
    ["data.tsv", "spreadsheet"],
    ["reports/summary.xlsx", "spreadsheet"],
    ["reports/legacy.xls", "spreadsheet"],
    ["reports/model.xlsm", "spreadsheet"],
    ["LICENSE", "text"],
    ["docs/manual.pdf", "pdf"],
    ["docs/manual.docx", "docx"],
    ["docs/slides.pptx", "pptx"],
    ["docs/page.html", "html"],
    ["assets/logo.png", "image"],
    ["assets/demo.mp4", "video"],
    ["assets/voice.m4a", "audio"],
    ["archive.bin", "unsupported"],
    ["legacy.doc", "unsupported"],
  ] as const)("classifies %s as %s", (file, expected) => {
    expect(previewKind(file)).toBe(expected)
  })

  it("falls back to editable text for unknown extensions", () => {
    expect(previewKind("notes.custom-extension")).toBe("text")
    expect(isEditableText("notes.custom-extension")).toBe(true)
    expect(isEditableText("docs/page.html")).toBe(true)
    expect(isEditableText("docs/page.htm")).toBe(true)
    expect(isEditableText("data.csv")).toBe(false)
    expect(isEditableText("reports/summary.xlsx")).toBe(false)
    expect(isEditableText("archive.bin")).toBe(false)
    expect(isEditableText("legacy.doc")).toBe(false)
  })

  it("recognizes hidden and ignored file nodes without hiding ordinary paths", () => {
    expect(isHiddenFileNode({ name: ".gitignore", path: ".gitignore", type: "file", ignored: false })).toBe(true)
    expect(isHiddenFileNode({ name: "config", path: "src/.config", type: "directory", ignored: false })).toBe(true)
    expect(isHiddenFileNode({ name: "dist", path: "dist", type: "directory", ignored: true })).toBe(true)
    expect(isHiddenFileNode({ name: "app.ts", path: "src/app.ts", type: "file", ignored: false })).toBe(false)
  })

  it("identifies deleted changes from common change shapes", () => {
    expect(isDeletedChange({ status: "deleted" })).toBe(true)
    expect(isDeletedChange({ type: "deleted" })).toBe(true)
    expect(isDeletedChange({ status: "modified" })).toBe(false)
    expect(isDeletedChange(undefined)).toBe(false)
  })
})
