import { afterEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import { keys } from "../../data/query-keys"
import { createDesktopClient } from "../../data/sdk"
import { createFakeJyycode } from "../../test/fake-jyycode"
import {
  createFileApi,
  fileContentQueryOptions,
  fileListQueryOptions,
  loadFileContent,
  loadFileList,
} from "./file-query"

afterEach(() => vi.restoreAllMocks())

describe("file queries", () => {
  it("loads directory listings and content with explicit workspace scope", async () => {
    const directory = "C:\\work\\demo"
    const workspaceID = "wrk_child"
    const backend = createFakeJyycode(directory)
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    const client = createDesktopClient(
      { baseUrl: "http://desktop.test", username: "jyycode", password: "secret" },
      directory,
    )

    expect(await loadFileList({ client, directory, workspaceID, relativePath: "src" })).toEqual(backend.fileNodes.src)
    expect(await loadFileContent({ client, directory, workspaceID, relativePath: "src/app.tsx" })).toMatchObject({
      type: "text",
      content: "export const app = true",
      revision: "file-revision-1",
    })
    expect(backend.requests.filter((request) => request.path === "/file")[0]?.query).toMatchObject({
      directory,
      workspace: workspaceID,
      path: "src",
    })
    expect(backend.requests.filter((request) => request.path === "/file/content")[0]?.query).toMatchObject({
      directory,
      workspace: workspaceID,
      path: "src/app.tsx",
    })
  })

  it("writes content, updates the scoped cache, and invalidates scoped diffs", async () => {
    const directory = "C:\\work\\demo"
    const workspaceID = "wrk_child"
    const sessionID = "ses_child"
    const relativePath = "src/app.tsx"
    const backend = createFakeJyycode(directory)
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    const client = createDesktopClient(
      { baseUrl: "http://desktop.test", username: "jyycode", password: "secret" },
      directory,
    )
    const queryClient = createDesktopQueryClient()
    const contentKey = keys.fileContent(directory, workspaceID, sessionID, relativePath)
    queryClient.setQueryData(contentKey, {
      type: "text" as const,
      content: "old",
      revision: "file-revision-1",
    })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const api = createFileApi({ client, directory, workspaceID, sessionID, queryClient })

    const result = await api.write({ path: "src\\app.tsx", content: "updated", revision: "file-revision-1" })

    expect(result.revision).toBe("file-revision-2")
    expect(queryClient.getQueryData(contentKey)).toMatchObject({ content: "updated", revision: "file-revision-2" })
    expect(backend.requests.at(-1)?.query).toMatchObject({ directory, workspace: workspaceID })
    expect(backend.requests.at(-1)?.body).toMatchObject({ path: relativePath })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: keys.sessionDiff(directory, workspaceID, sessionID),
      exact: true,
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: keys.vcsDiff(directory, workspaceID, sessionID, relativePath),
      exact: true,
    })
  })

  it("keeps query keys isolated by directory and workspace", () => {
    const base = { client: {} as never, directory: "C:\\work\\demo" }
    expect(fileListQueryOptions({ ...base, workspaceID: "wrk_a", relativePath: "src" }).queryKey).not.toEqual(
      fileListQueryOptions({ ...base, workspaceID: "wrk_b", relativePath: "src" }).queryKey,
    )
    expect(
      fileContentQueryOptions({ ...base, workspaceID: "wrk_a", relativePath: "src/app.tsx" }).queryKey,
    ).not.toEqual(
      fileContentQueryOptions({
        ...base,
        directory: "C:\\work\\other",
        workspaceID: "wrk_a",
        relativePath: "src/app.tsx",
      }).queryKey,
    )
  })

  it("uses cache freshness and watcher invalidation instead of polling on mount/focus", () => {
    expect(fileListQueryOptions({ client: {} as never, directory: "C:\\work\\demo" })).toMatchObject({
      refetchOnMount: true,
      refetchOnWindowFocus: false,
    })
    expect(fileContentQueryOptions({ client: {} as never, directory: "C:\\work\\demo" })).toMatchObject({
      refetchInterval: false,
      refetchOnMount: true,
      refetchOnWindowFocus: false,
    })
    expect(
      fileContentQueryOptions({ client: {} as never, directory: "C:\\work\\demo", live: true }).refetchInterval,
    ).toBe(false)
  })
})
