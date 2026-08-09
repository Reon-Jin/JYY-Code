import { describe, expect, it } from "vitest"
import { createFileMediaUrl, createFilePreviewUrl } from "./sdk"

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

describe("createFilePreviewUrl", () => {
  it("keeps the project, workspace, auth, and file path in the resource URL", () => {
    const result = new URL(
      createFilePreviewUrl({
        bootstrap: { baseUrl: "http://desktop.test/", username: "jyycode", password: "secret" },
        directory: "C:\\work\\demo",
        path: "src\\index.html",
        workspaceID: "wrk_child",
      }),
    )

    expect(result.pathname).toBe(
      `/file/preview/${encodeURIComponent("C:\\work\\demo")}/wrk_child/${encodeURIComponent(btoa("jyycode:secret"))}/src/index.html`,
    )
  })
})
