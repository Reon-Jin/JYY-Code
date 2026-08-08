import { afterEach, describe, expect, it, vi } from "vitest"
import { createDesktopClient } from "../../data/sdk"
import { createFakeJyycode } from "../../test/fake-jyycode"
import { loadChanges } from "./changes-query"

afterEach(() => vi.restoreAllMocks())

describe("changes query", () => {
  it("uses the explicit Git diff source", async () => {
    const directory = "C:\\work\\demo"
    const backend = createFakeJyycode(directory)
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    const client = createDesktopClient(
      { baseUrl: "http://desktop.test", username: "jyycode", password: "secret" },
      directory,
    )

    expect(await loadChanges({ client, directory, mode: "git", workspaceID: "wrk_main" })).toEqual(backend.changes)
    expect(backend.requests.at(-1)?.query).toMatchObject({ directory, workspace: "wrk_main", mode: "git" })
  })

  it("uses session diff for non-Git workspaces", async () => {
    const directory = "C:\\work\\demo"
    const sessionID = "ses_child"
    const backend = createFakeJyycode(directory)
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    const client = createDesktopClient(
      { baseUrl: "http://desktop.test", username: "jyycode", password: "secret" },
      directory,
    )

    expect(await loadChanges({ client, directory, mode: "session", sessionID, workspaceID: "wrk_child" })).toEqual(
      backend.sessionChanges,
    )
    expect(backend.requests.at(-1)?.query).toMatchObject({ directory, workspace: "wrk_child" })
    expect(backend.requests.at(-1)?.path).toBe(`/session/${sessionID}/diff`)
  })
})
