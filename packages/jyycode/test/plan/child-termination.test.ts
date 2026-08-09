import { describe, expect, test } from "bun:test"
import { terminateChild } from "../../src/plan/child-termination"

describe("child termination coordinator", () => {
  test("cancels, waits for idle, disposes, and archives in order", async () => {
    const events: string[] = []
    let statusCalls = 0
    const result = await terminateChild(
      {
        sessionId: "ses_child",
        request: { workspace: { mode: "snapshot", directory: "C:/runtime/child" } },
      },
      {
        markIntent: () => events.push("intent"),
        cancel: async () => {
          events.push("cancel")
        },
        status: async () => {
          events.push("status")
          statusCalls++
          return statusCalls < 2 ? { type: "busy" } : { type: "idle" }
        },
        disposeDirectory: async () => {
          events.push("dispose")
        },
        archive: async () => {
          events.push("archive")
        },
      },
      { cancelTimeoutMs: 20, idleTimeoutMs: 20, disposeTimeoutMs: 20, archiveTimeoutMs: 20, sleep: async () => {} },
    )

    expect(result).toEqual({ state: "stopped", cancelled: true, idle: true, disposed: true, archived: true })
    expect(events).toEqual(["intent", "cancel", "status", "status", "dispose", "archive"])
  })

  test("does not dispose or archive when cancellation times out", async () => {
    const events: string[] = []
    const result = await terminateChild(
      { sessionId: "ses_busy", request: { workspace: { mode: "worktree", directory: "C:/runtime/child" } } },
      {
        cancel: () => new Promise<void>(() => {}),
        status: async () => {
          events.push("status")
          return { type: "idle" }
        },
        disposeDirectory: async () => events.push("dispose"),
        archive: async () => events.push("archive"),
      },
      { cancelTimeoutMs: 5, idleTimeoutMs: 5, disposeTimeoutMs: 5, archiveTimeoutMs: 5 },
    )

    expect(result.state).toBe("stop_failed")
    expect(result.state === "stop_failed" && result.phase).toBe("cancel")
    expect(events).toEqual([])
  })

  test("preserves the workspace when the child never becomes idle", async () => {
    const events: string[] = []
    const result = await terminateChild(
      { sessionId: "ses_busy", request: { workspace: { mode: "snapshot", directory: "C:/runtime/child" } } },
      {
        cancel: async () => events.push("cancel"),
        status: async () => {
          events.push("status")
          return { type: "busy" }
        },
        disposeDirectory: async () => events.push("dispose"),
        archive: async () => events.push("archive"),
      },
      { cancelTimeoutMs: 20, idleTimeoutMs: 5, pollIntervalMs: 1 },
    )

    expect(result.state).toBe("stop_failed")
    expect(result.state === "stop_failed" && result.phase).toBe("idle")
    expect(events).not.toContain("dispose")
    expect(events).not.toContain("archive")
  })
})
