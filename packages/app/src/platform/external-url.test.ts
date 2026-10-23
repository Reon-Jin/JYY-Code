import { afterEach, describe, expect, it, vi } from "vitest"
import { openExternalUrl } from "./external-url"

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe("Markdown external URLs", () => {
  it("opens only web URLs with opener isolation", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    await openExternalUrl("HTTPS://example.com/path?q=1")
    expect(open).toHaveBeenCalledWith("https://example.com/path?q=1", "_blank", "noopener,noreferrer")
    for (const source of ["javascript:alert(1)", "file:///C:/Windows/cmd.exe", "data:text/html,test"]) {
      await expect(openExternalUrl(source)).rejects.toThrow()
    }
    expect(open).toHaveBeenCalledTimes(1)
  })
})
