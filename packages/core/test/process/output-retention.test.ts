import { describe, expect, test } from "bun:test"
import { createOutputRetention, modelOutputSummary, retainOutput } from "@jyycode-ai/core/output-retention"

const bytes = (value: string) => new TextEncoder().encode(value)

describe("output retention", () => {
  test("retains UTF-8 bytes without splitting decoded characters and merges stream order", async () => {
    const retention = createOutputRetention({ maxBytes: 22, strategy: "head_tail" })
    await retention.append(bytes("头部\x1b[31m"))
    await retention.append(bytes("中间\x1b[0m"))
    await retention.append(bytes("尾部"))

    const result = await retention.flush()

    expect(result.bytesSeen).toBe(Buffer.byteLength("头部\x1b[31m中间\x1b[0m尾部"))
    expect(result.bytesRetained).toBeLessThanOrEqual(22)
    expect(result.truncated).toBe(true)
    expect(result.preview).not.toContain("�")
    expect(result.preview).toContain("\x1b[")
  })

  test("supports head and tail retention with an exact over-limit byte count", async () => {
    const result = await retainOutput([bytes("HEAD-"), bytes("middle-"), bytes("TAIL")], {
      maxBytes: 9,
      strategy: "head_tail",
    })

    expect(result.bytesSeen).toBe(16)
    expect(result.bytesRetained).toBe(9)
    expect(result.truncated).toBe(true)
    expect(result.preview).toContain("HEAD")
    expect(result.preview).toContain("TAIL")
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test("spills the complete merged stream and reports a recoverable model reference", async () => {
    const written: Uint8Array[] = []
    const result = await retainOutput([bytes("first\n"), bytes("second\n"), bytes("third")], {
      maxBytes: 8,
      strategy: "tail",
      spill: "on_truncate",
      blob: {
        write: async (source) => {
          for await (const chunk of source) written.push(chunk)
          return { ref: "blob:sha256:test-output" }
        },
      },
    })

    expect(Buffer.concat(written.map((chunk) => Buffer.from(chunk))).toString("utf8")).toBe("first\nsecond\nthird")
    expect(result.blobRef).toBe("blob:sha256:test-output")
    expect(modelOutputSummary(result)).toContain("blob:sha256:test-output")
    expect(modelOutputSummary(result)).toContain("bytesSeen=18")
  })

  test("keeps a bounded preview when blob spilling fails", async () => {
    const result = await retainOutput([bytes("x".repeat(100))], {
      maxBytes: 8,
      blob: {
        write: async () => {
          throw new Error("disk full")
        },
      },
    })

    expect(result.bytesSeen).toBe(100)
    expect(result.bytesRetained).toBe(8)
    expect(result.blobRef).toBeUndefined()
    expect(result.blobError).toContain("disk full")
    expect(modelOutputSummary(result)).toContain("full output is unavailable")
  })

  test("cancel flushes the bytes already observed", async () => {
    const retention = createOutputRetention({ maxBytes: 8, strategy: "head" })
    await retention.append(bytes("before-cancel"))

    const result = await retention.cancel()

    expect(result.bytesSeen).toBe(13)
    expect(result.truncated).toBe(true)
    expect(result.preview).toContain("before")
  })
})
