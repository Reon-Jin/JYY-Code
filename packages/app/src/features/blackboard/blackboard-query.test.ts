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

  it("uses the root board key and invalidates only that key after mutations", async () => {
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
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["project", "c:\\work", "blackboards", "ses_root"],
      ["project", "c:\\work", "blackboards", "ses_root"],
    ])
  })

  it("uses a stable root-scoped query key", () => {
    expect(
      blackboardQueryOptions({ client: {} as never, directory: "C:\\work", rootSessionID: "ses_root" }).queryKey,
    ).toEqual(["project", "c:\\work", "blackboards", "ses_root"])
  })

  it("falls back to general purpose for snapshots from older servers", () => {
    expect(blackboardMessagePurpose({})).toBe("general")
    expect(blackboardMessagePurpose({ purpose: "candidate_declaration" })).toBe("candidate_declaration")
  })
})
