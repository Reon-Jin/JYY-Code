import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MAX_OPEN_DOCUMENTS,
  DocumentCache,
  HARD_MAX_OPEN_DOCUMENTS,
  limitDiagnostics,
} from "@/lsp/document-cache"

describe("LSP document cache", () => {
  test("keeps a bounded LRU and reports evictions", () => {
    const cache = new DocumentCache({ maxOpenDocuments: 2 })
    cache.set("a", 0, "a")
    cache.set("b", 0, "b")
    expect(cache.get("a")?.version).toBe(0)
    const evicted = cache.set("c", 0, "c")
    expect(evicted.map((item) => item.key)).toEqual(["b"])
    expect(cache.keys()).toEqual(["a", "c"])
    expect(cache.size).toBe(2)
  })

  test("clamps configuration and caps stored text and diagnostics", () => {
    const cache = new DocumentCache({ maxOpenDocuments: 999, maxDocumentTextBytes: 4 })
    expect(cache.maxOpenDocuments).toBe(HARD_MAX_OPEN_DOCUMENTS)
    expect(new DocumentCache().maxOpenDocuments).toBe(DEFAULT_MAX_OPEN_DOCUMENTS)
    const entry = cache.set("large", 1, "😀abcdef")[0]
    expect(entry).toBeUndefined()
    expect(cache.get("large")?.textTruncated).toBe(true)
    expect(Buffer.byteLength(cache.get("large")?.text ?? "")).toBeLessThanOrEqual(4)
    expect(limitDiagnostics(Array.from({ length: 3 }, (_, index) => index), 2)).toEqual([0, 1])
  })
})
