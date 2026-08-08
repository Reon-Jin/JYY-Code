import { describe, expect, it } from "vitest"
import { createFileMediaUrl } from "./sdk"

describe("createFileMediaUrl", () => {
  it("builds an authenticated, scoped streaming URL", () => {
    const result = new URL(
      createFileMediaUrl({
        bootstrap: { baseUrl: "http://desktop.test/", username: "jyycode", password: "secret" },
        directory: "C:\\work\\demo",
        path: "media\\clip.mp4",
        workspaceID: "wrk_child",
      }),
    )

    expect(result.pathname).toBe("/file/raw")
    expect(result.searchParams.get("directory")).toBe("C:\\work\\demo")
    expect(result.searchParams.get("path")).toBe("media/clip.mp4")
    expect(result.searchParams.get("workspace")).toBe("wrk_child")
    expect(result.searchParams.get("auth_token")).toBe(btoa("jyycode:secret"))
  })
})
