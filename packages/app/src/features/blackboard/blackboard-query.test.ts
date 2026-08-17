import { describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import {
  blackboardMessagePurpose,
  blackboardQueryOptions,
  createBlackboardApi,
  loadBlackboard,
} from "./blackboard-query"

describe("blackboard query boundary", () => {
  it("loads a root-scoped snapshot with optional step filters", async () => {
    const snapshot = { rootSessionID: "ses_root", currentStepID: "step_1" }
    const blackboard = vi.fn().mockResolvedValue({ data: snapshot })
    const client = { session: { blackboard } } as never

    await expect(
      loadBlackboard({
        client,
        directory: "C:\\work",
        rootSessionID: "ses_root",
        stepID: "step_1",
        taskID: "task_1",
        before: "bb_10",
        limit: 20,
      }),
    ).resolves.toEqual(snapshot)
    expect(blackboard).toHaveBeenCalledWith(
      {
        directory: "C:\\work",
        sessionID: "ses_root",
        stepID: "step_1",
        taskID: "task_1",
        before: "bb_10",
        limit: "20",
      },
      { throwOnError: true },
    )
  })

  it("invalidates the whole board prefix after mutations so every Step's cache refreshes", async () => {
    const post = vi.fn().mockResolvedValue({ data: { id: "bb_1" } })
    const read = vi.fn().mockResolvedValue({ data: true })
    const client = { session: { blackboard: vi.fn(), blackboard2: { post, read } } } as never
    const queryClient = createDesktopQueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const api = createBlackboardApi({ client, directory: "C:\\work", rootSessionID: "ses_root", queryClient })

    await expect(api.post({ message: "Please inspect", kind: "help", taskIDs: ["task_1"] })).resolves.toEqual({
      id: "bb_1",
    })
    await expect(api.markRead({ stepID: "step_1", throughMessageID: "bb_1" })).resolves.toBe(true)

    expect(post).toHaveBeenCalledWith(
      {
        directory: "C:\\work",
        sessionID: "ses_root",
        message: "Please inspect",
        kind: "help",
        task_ids: ["task_1"],
      },
      { throwOnError: true },
    )
    expect(read).toHaveBeenCalledWith(
      { directory: "C:\\work", sessionID: "ses_root", stepID: "step_1", throughMessageID: "bb_1" },
      { throwOnError: true },
    )
    expect(invalidate.mock.calls.map(([filters]) => [filters?.queryKey, filters?.exact])).toEqual([
      [["project", "c:\\work", "blackboards", "ses_root"], false],
      [["project", "c:\\work", "blackboards", "ses_root"], false],
    ])
  })

  it("uses a stable root-scoped query key", () => {
    expect(
      blackboardQueryOptions({ client: {} as never, directory: "C:\\work", rootSessionID: "ses_root" }).queryKey,
    ).toEqual(["project", "c:\\work", "blackboards", "ses_root"])
  })

  it("caches each Step under its own key so switching Steps cannot mix notes", () => {
    const base = blackboardQueryOptions({ client: {} as never, directory: "C:\\work", rootSessionID: "ses_root" })
    const first = blackboardQueryOptions({
      client: {} as never,
      directory: "C:\\work",
      rootSessionID: "ses_root",
      stepID: "step_1",
    })
    const second = blackboardQueryOptions({
      client: {} as never,
      directory: "C:\\work",
      rootSessionID: "ses_root",
      stepID: "step_2",
    })
    expect(first.queryKey).toEqual(["project", "c:\\work", "blackboards", "ses_root", "step", "step_1"])
    expect(first.queryKey).not.toEqual(base.queryKey)
    expect(first.queryKey).not.toEqual(second.queryKey)
    expect(second.queryKey).toEqual(["project", "c:\\work", "blackboards", "ses_root", "step", "step_2"])
  })

  it("falls back to general purpose for snapshots from older servers", () => {
    expect(blackboardMessagePurpose({})).toBe("general")
    expect(blackboardMessagePurpose({ purpose: "candidate_declaration" })).toBe("candidate_declaration")
  })
})
