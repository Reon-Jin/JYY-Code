import type { VcsBranches } from "@jyycode-ai/sdk/v2/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "./query-client"
import { keys } from "./query-keys"
import { createDesktopClient } from "./sdk"
import { loadChanges } from "../features/changes/changes-query"
import { createGitApi, loadVcsBranches, loadVcsInfo } from "../features/git/git-query"
import {
  createGitHubApi,
  loadGitHubStatus,
  loadPullRequest,
  loadPullRequestDiff,
  loadPullRequests,
} from "../features/github/github-query"
import { createFakeJyycode } from "../test/fake-jyycode"

afterEach(() => vi.restoreAllMocks())

describe("workspace inspector queries", () => {
  it("loads workspace-scoped data through generated SDK methods", async () => {
    const directory = "C:\\work\\demo"
    const backend = createFakeJyycode(directory)
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    const client = createDesktopClient(
      { baseUrl: "http://desktop.test", username: "jyycode", password: "secret" },
      directory,
    )

    expect(await loadChanges({ client, directory, mode: "git" })).toEqual(backend.changes)
    expect(await loadVcsInfo({ client, directory })).toMatchObject({ branch: "main" })
    expect(await loadVcsBranches({ client, directory })).toEqual(backend.branches)
    expect(await loadGitHubStatus({ client, directory })).toEqual(backend.githubStatus)
    expect(await loadPullRequests({ client, directory, state: "open" })).toHaveLength(1)
    expect(await loadPullRequest({ client, directory, number: 1 })).toMatchObject({ number: 1 })
    expect(await loadPullRequestDiff({ client, directory, number: 1 })).toContain("@@")

    expect(backend.requests.find((request) => request.path === "/vcs/diff")?.query).toMatchObject({
      directory,
      mode: "git",
    })
  })

  it("writes returned branches and invalidates mutation side effects", async () => {
    const directory = "C:\\work\\demo"
    const backend = createFakeJyycode(directory)
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    const client = createDesktopClient(
      { baseUrl: "http://desktop.test", username: "jyycode", password: "secret" },
      directory,
    )
    const queryClient = createDesktopQueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const git = createGitApi({ client, directory, queryClient })

    await git.createBranch({ name: "feature", checkout: true })

    expect(queryClient.getQueryData<VcsBranches>(keys.vcsBranches(directory))?.current).toBe("feature")
    expect(queryClient.getQueryData(keys.vcsInfo(directory))).toMatchObject({ branch: "feature" })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.vcsDiff(directory), exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.pullRequestsScope(directory), exact: false })
  })

  it("routes GitHub mutations and invalidates the affected pull request", async () => {
    const directory = "C:\\work\\demo"
    const backend = createFakeJyycode(directory)
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)
    const client = createDesktopClient(
      { baseUrl: "http://desktop.test", username: "jyycode", password: "secret" },
      directory,
    )
    const queryClient = createDesktopQueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const github = createGitHubApi({ client, directory, queryClient })

    await github.edit({ number: 1, title: "Updated", body: "Updated body" })
    await github.comment({ number: 1, body: "Looks good" })
    await github.checkout({ number: 1, branch: "feature/inspector" })
    expect(queryClient.getQueryData(keys.vcsInfo(directory))).toMatchObject({ branch: "feature/inspector" })
    await github.close({ number: 1 })
    await github.reopen({ number: 1 })
    await github.merge({ number: 1, method: "squash", deleteBranch: true })

    expect(backend.pullRequestDetails.get(1)).toMatchObject({ title: "Updated", state: "MERGED" })
    expect(backend.pullRequestDetails.get(1)?.comments[0]?.body).toBe("Looks good")
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.pullRequest(directory, 1), exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.pullRequestsScope(directory), exact: false })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.vcsBranches(directory), exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.vcsDiff(directory), exact: true })
  })
})
